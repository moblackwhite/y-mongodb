import * as Y from 'yjs'
import * as binary from 'lib0/binary.js'
import * as promise from 'lib0/promise.js'
import * as buffer from 'lib0/buffer.js'
import { MongoClient, Binary, Db } from 'mongodb'

export const PREFERRED_TRIM_SIZE = 500

/**
 * For now this is a helper method that creates a Y.Doc and then re-encodes a document update.
 * In the future this will be handled by Yjs without creating a Y.Doc (constant memory consumption).
 *
 * @param {Array<Uint8Array>} updates
 * @return {{update:Uint8Array, sv: Uint8Array}}
 */
const mergeUpdates = (updates) => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => {
        for (let i = 0; i < updates.length; i++) {
            Y.applyUpdate(ydoc, updates[i])
        }
    })
    return { update: Y.encodeStateAsUpdate(ydoc), sv: Y.encodeStateVector(ydoc) }
}

/**
 * @param {Db} db
 * @param {string} docName
 * @return {Promise<number>} Returns -1 if this document doesn't exist yet
 */
const getCurrentUpdateClock = async (db, docName) => {
    const collection = db.collection('updates')
    const result = await collection
        .find({ docName })
        .sort({ clock: -1 })
        .limit(1)
        .toArray()

    return result.length === 0 ? -1 : result[0].clock
}

/**
 * @param {Db} db
 * @param {string} docName
 * @param {Uint8Array} sv state vector
 * @param {number} clock current clock of the document so we can determine when this statevector was created
 */
const writeStateVector = async (db, docName, sv, clock) => {
    const collection = db.collection('stateVectors')
    await collection.updateOne(
        { docName },
        { $set: { docName, sv: new Binary(Buffer.from(sv)), clock } },
        { upsert: true }
    )
}

/**
 * @param {Db} db
 * @param {string} docName
 */
const readStateVector = async (db, docName) => {
    const collection = db.collection('stateVectors')
    const result = await collection.findOne({ docName })

    if (!result) {
        return { sv: null, clock: -1 }
    }

    return { sv: new Uint8Array(result.sv.buffer), clock: result.clock }
}

/**
 * @param {Db} db
 * @param {string} docName
 * @param {Uint8Array} stateAsUpdate
 * @param {Uint8Array} stateVector
 * @return {Promise<number>} returns the clock of the flushed doc
 */
const flushDocument = async (db, docName, stateAsUpdate, stateVector) => {
    const clock = await storeUpdate(db, docName, stateAsUpdate)
    await writeStateVector(db, docName, stateVector, clock)

    // Clear old updates
    const collection = db.collection('updates')
    await collection.deleteMany({ docName, clock: { $lt: clock } })

    return clock
}

/**
 * @param {Db} db
 * @param {string} docName
 * @param {Uint8Array} update
 * @return {Promise<number>} Returns the clock of the stored update
 */
const storeUpdate = async (db, docName, update) => {
    const collection = db.collection('updates')
    const currentClock = await getCurrentUpdateClock(db, docName)
    const nextClock = currentClock + 1

    if (currentClock === -1) {
        // First update, create initial state vector
        const ydoc = new Y.Doc()
        Y.applyUpdate(ydoc, update)
        const sv = Y.encodeStateVector(ydoc)
        await writeStateVector(db, docName, sv, 0)
    }

    await collection.insertOne({
        docName,
        clock: nextClock,
        update: new Binary(Buffer.from(update))
    })

    return nextClock
}

export class MongodbPersistence {
    /**
     * @param {string} connectionString MongoDB connection string
     * @param {object} [opts] Options
     * @param {string} [opts.dbName] Database name
     * @param {number} [opts.flushSize] Flush size
     */
    constructor(connectionString, { dbName = 'yjs', flushSize = PREFERRED_TRIM_SIZE } = {}) {
        this.client = new MongoClient(connectionString)
        this.db = this.client.db(dbName)
        this.tr = promise.resolve()

        // Create indexes
        this._initIndexes()
    }

    async _initIndexes() {
        const updatesCollection = this.db.collection('updates')
        await updatesCollection.createIndex({ docName: 1, clock: 1 }, { unique: true })

        const stateVectorCollection = this.db.collection('stateVectors')
        await stateVectorCollection.createIndex({ docName: 1 }, { unique: true })

        const metaCollection = this.db.collection('meta')
        await metaCollection.createIndex({ docName: 1, key: 1 }, { unique: true })
    }

    /**
     * Execute a transaction on the database. This will ensure that other processes are currently not writing.
     *
     * @template T
     * @param {function(Db):Promise<T>} f A transaction that receives the db object
     * @return {Promise<T>}
     */
    _transact(f) {
        const currTr = this.tr
        this.tr = (async () => {
            await currTr
            let res = null
            try {
                res = await f(this.db)
            } catch (err) {
                console.warn('Error during y-mongodb transaction', err)
            }
            return res
        })()
        return this.tr
    }

    /**
     * @param {string} docName
     */
    flushDocument(docName) {
        return this._transact(async db => {
            const updatesCollection = db.collection('updates')
            const updates = await updatesCollection
                .find({ docName })
                .sort({ clock: 1 })
                .toArray()

            const updateBuffers = updates.map(doc => new Uint8Array(doc.update.buffer))
            const { update, sv } = mergeUpdates(updateBuffers)
            await flushDocument(db, docName, update, sv)
        })
    }

    /**
     * @param {string} docName
     * @return {Promise<Y.Doc>}
     */
    getYDoc(docName) {
        return this._transact(async db => {
            const updatesCollection = db.collection('updates')
            const updates = await updatesCollection
                .find({ docName })
                .sort({ clock: 1 })
                .toArray()

            const ydoc = new Y.Doc()
            ydoc.transact(() => {
                for (const update of updates) {
                    Y.applyUpdate(ydoc, new Uint8Array(update.update.buffer))
                }
            })

            if (updates.length > PREFERRED_TRIM_SIZE) {
                await flushDocument(db, docName, Y.encodeStateAsUpdate(ydoc), Y.encodeStateVector(ydoc))
            }

            return ydoc
        })
    }

    /**
     * @param {string} docName
     * @return {Promise<Uint8Array>}
     */
    getStateVector(docName) {
        return this._transact(async db => {
            const { clock, sv } = await readStateVector(db, docName)
            let curClock = -1

            if (sv !== null) {
                curClock = await getCurrentUpdateClock(db, docName)
            }

            if (sv !== null && clock === curClock) {
                return sv
            } else {
                // Current state vector is outdated
                const updatesCollection = db.collection('updates')
                const updates = await updatesCollection
                    .find({ docName })
                    .sort({ clock: 1 })
                    .toArray()

                const updateBuffers = updates.map(doc => new Uint8Array(doc.update.buffer))
                const { update, sv } = mergeUpdates(updateBuffers)
                await flushDocument(db, docName, update, sv)
                return sv
            }
        })
    }

    /**
     * @param {string} docName
     * @param {Uint8Array} update
     * @return {Promise<number>} Returns the clock of the stored update
     */
    storeUpdate(docName, update) {
        return this._transact(db => storeUpdate(db, docName, update))
    }

    /**
     * @param {string} docName
     * @param {Uint8Array} stateVector
     */
    async getDiff(docName, stateVector) {
        const ydoc = await this.getYDoc(docName)
        return Y.encodeStateAsUpdate(ydoc, stateVector)
    }

    /**
     * @param {string} docName
     * @return {Promise<void>}
     */
    clearDocument(docName) {
        return this._transact(async db => {
            await db.collection('stateVectors').deleteOne({ docName })
            await db.collection('updates').deleteMany({ docName })
            await db.collection('meta').deleteMany({ docName })
        })
    }

    /**
     * @param {string} docName
     * @param {string} metaKey
     * @param {any} value
     * @return {Promise<void>}
     */
    setMeta(docName, metaKey, value) {
        return this._transact(async db => {
            const collection = db.collection('meta')
            await collection.updateOne(
                { docName, key: metaKey },
                { $set: { docName, key: metaKey, value } },
                { upsert: true }
            )
        })
    }

    /**
     * @param {string} docName
     * @param {string} metaKey
     * @return {Promise<void>}
     */
    delMeta(docName, metaKey) {
        return this._transact(async db => {
            const collection = db.collection('meta')
            await collection.deleteOne({ docName, key: metaKey })
        })
    }

    /**
     * @param {string} docName
     * @param {string} metaKey
     * @return {Promise<any>}
     */
    getMeta(docName, metaKey) {
        return this._transact(async db => {
            const collection = db.collection('meta')
            const result = await collection.findOne({ docName, key: metaKey })
            return result ? result.value : undefined
        })
    }

    /**
     * @return {Promise<Array<string>>}
     */
    getAllDocNames() {
        return this._transact(async db => {
            const collection = db.collection('stateVectors')
            const docs = await collection.find({}).toArray()
            return docs.map(doc => doc.docName)
        })
    }

    /**
     * @return {Promise<Array<{ name: string, sv: Uint8Array, clock: number }>>}
     */
    getAllDocStateVectors() {
        return this._transact(async db => {
            const collection = db.collection('stateVectors')
            const docs = await collection.find({}).toArray()
            return docs.map(doc => ({
                name: doc.docName,
                sv: new Uint8Array(doc.sv.buffer),
                clock: doc.clock
            }))
        })
    }

    /**
     * @param {string} docName
     * @return {Promise<Map<string, any>>}
     */
    getMetas(docName) {
        return this._transact(async db => {
            const collection = db.collection('meta')
            const metas = await collection.find({ docName }).toArray()
            const metaMap = new Map()
            metas.forEach(meta => {
                metaMap.set(meta.key, meta.value)
            })
            return metaMap
        })
    }

    /**
     * Close connection to MongoDB and discard all state and bindings
     *
     * @return {Promise<void>}
     */
    destroy() {
        return this._transact(async () => {
            await this.client.close()
        })
    }

    /**
     * Delete all data in database.
     */
    clearAll() {
        return this._transact(async db => {
            await db.collection('updates').deleteMany({})
            await db.collection('stateVectors').deleteMany({})
            await db.collection('meta').deleteMany({})
        })
    }
}