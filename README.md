# MongoDB database adapter for [Yjs](https://github.com/yjs/yjs)

- This was once a fork of the official [y-leveldb](https://github.com/yjs/y-leveldb) but for MongoDB
- This package refers to the repository [y-mongodb-provider](https://github.com/MaxNoetzold/y-mongodb-provider)
- This package is not officially supported by the Yjs team.


I integrated it with [y-websocket-server](https://github.com/yjs/y-websocket-server) v0.1.1, so I created a separate repository for it.

## Use it

```sh
pnpm i @hardyhu/y-mongodb
```

```js
import * as Y from 'yjs'
import { MongodbPersistence } from '@hardyhu/y-mongodb'

const persistence = new MongodbPersistence('mongodb://localhost:27017/')

const ydoc = new Y.Doc()
ydoc.getArray('arr').insert(0, [1, 2, 3])
ydoc.getArray('arr').toArray() // => [1, 2, 3]

// store document updates retrieved from other clients
persistence.storeUpdate('my-doc', Y.encodeStateAsUpdate(ydoc))

// when you want to sync, or store data to a database,
// retrieve the temporary Y.Doc to consume data
const ydocPersisted = await persistence.getYDoc('my-doc')
ydocPersisted.getArray('arr') // [1, 2, 3]
```

## API

### `persistence = MongodbPersistence(connectionString, [{ [dbName] }])`

Create a y-mongodb persistence instance.

```js
import { MongodbPersistence } from '@hardyhu/y-mongodb'

const persistence = new MongodbPersistence('mongodb://localhost:27017/', { dbName })
```

#### `persistence.getYDoc(docName: string): Promise<Y.Doc>`

Create a Y.Doc instance with the data persisted in mongodb. Use this to
temporarily create a Yjs document to sync changes or extract data.

#### `persistence.storeUpdate(docName: string, update: Uint8Array): Promise`

Store a single document update to the database.

#### `persistence.getStateVector(docName: string): Promise<Uint8Array>`

The state vector (describing the state of the persisted document - see
[Yjs docs](https://github.com/yjs/yjs#Document-Updates)) is maintained in a separate
field and constantly updated.

This allows you to sync changes without actually creating a Yjs document.

#### `persistence.getDiff(docName: string, stateVector: Uint8Array): Promise<Uint8Array>`

Get the differences directly from the database. The same as
`Y.encodeStateAsUpdate(ydoc, stateVector)`.

#### `persistence.clearDocument(docName: string): Promise`

Delete a document, and all associated data from the database.

#### `persistence.setMeta(docName: string, metaKey: string, value: any): Promise`

Persist some meta information in the database and associate it with a document.
It is up to you what you store here. You could, for example, store credentials
here.

#### `persistence.getMeta(docName: string, metaKey: string): Promise<any|undefined>`

Retrieve a store meta value from the database. Returns undefined if the
`metaKey` doesn't exist.

#### `persistence.delMeta(docName: string, metaKey: string): Promise`

Delete a store meta value.

#### `persistence.getAllDocNames(docName: string): Promise<Array<string>>`

Retrieve the names of all stored documents.

#### `persistence.getAllDocStateVectors(docName: string): Promise<Array<{ name:string,clock:number,sv:Uint8Array}`

Retrieve the state vectors of all stored documents. You can use this to sync
two y-mongodb instances.

Note: The state vectors might be outdated if the associated document is not
yet flushed. So use with caution.

#### `persistence.flushDocument(docName: string): Promise` (dev only)

Internally y-mongodb stores incremental updates. You can merge all document
updates to a single entry. You probably never have to use this.

## License

y-mongodb is licensed under the [MIT License](./LICENSE).

<1243971719@qq.com>
