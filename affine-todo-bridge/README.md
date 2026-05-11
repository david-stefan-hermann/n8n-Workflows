# affine-todo-bridge

A small Node.js service that creates todo items in AFFiNE via the real-time sync protocol.
Used as a bridge between n8n and a self-hosted AFFiNE instance.

## How it works

1. n8n sends a POST request with a todo title and description
2. The bridge fetches the target AFFiNE page as a Yjs binary document
3. A new todo block is appended using Yjs CRDT operations
4. The diff is pushed to AFFiNE via Socket.IO

## Deployment

Copy `.env.example` to `.env`, fill in your values, then start with Docker Compose:

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

The service listens on port `30170` by default.

## API

```
POST /todo
Content-Type: application/json

{ "title": "...", "description": "...", "emailFrom": "...", "emailDate": "..." }
```

```
GET /health  →  { "ok": true }
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AFFINE_WORKSPACE_ID` | yes | Workspace UUID from the AFFiNE URL |
| `AFFINE_EMAIL` | yes | Login email for Socket.IO session auth |
| `AFFINE_PASSWORD` | yes | Login password |
| `AFFINE_TOKEN` | no | API token for REST calls (doc reads) |
| `AFFINE_TODO_DOC_ID` | no | Fixed page ID to append todos to. If empty, creates a new page per run. |
| `AFFINE_URL` | no | Defaults to `https://affine.avernus.cloud` |

---

## AFFiNE API — hard-won findings (v0.26)

AFFiNE has no official API documentation. These are the findings from reverse-engineering
the sync protocol (see [discussion #6052](https://github.com/toeverything/AFFiNE/discussions/6052)):

### Reading a document

```
GET /api/workspaces/:workspaceId/docs/:docId
Authorization: Bearer <token>
```

Returns raw Yjs binary. Apply it with `Y.applyUpdate(doc, bytes)`.

### Writing — Socket.IO only

REST `PUT`/`POST` to the doc endpoint returns 404.  
GraphQL `applyDocUpdates` returns 500 (broken in v0.26).  
**The only working write path is Socket.IO.**

```js
import { io } from 'socket.io-client';

// 1. Auth: session cookie from email/password login — Bearer tokens do NOT work
const loginRes = await fetch(`${AFFINE_URL}/api/auth/sign-in`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
// extract affine_session cookie from set-cookie header

// 2. Connect with cookie
const socket = io(AFFINE_URL, {
  transports: ['websocket'],
  withCredentials: true,
  extraHeaders: { cookie: `affine_session=${sessionCookie}` },
});

// 3. Join — clientVersion is required, omitting it causes silent success:false
const joinRes = await socket.emitWithAck('space:join', {
  spaceType: 'workspace',
  spaceId: workspaceId,
  clientVersion: '0.26.0',   // ← required
});
if (!joinRes?.data?.success) throw new Error('join failed');

// 4. Push — field is 'update' (singular), not 'updates'
const pushRes = await socket.emitWithAck('space:push-doc-update', {
  spaceType: 'workspace',
  spaceId: workspaceId,
  docId,
  update: Buffer.from(yjsDiff).toString('base64'),  // ← 'update', not 'updates'
});
```

### Block structure (affine:list todo)

```js
const block = new Y.Map();
block.set('sys:id', id);
block.set('sys:flavour', 'affine:list');
block.set('sys:version', 1);
block.set('sys:children', new Y.Array());
block.set('prop:type', 'todo');
block.set('prop:text', new Y.Text('task description'));
block.set('prop:checked', false);
block.set('prop:collapsed', false);
```

Add the block to the `blocks` Y.Map and push its ID into the parent `affine:note`'s
`sys:children` array. Then encode the diff with `Y.encodeStateAsUpdate(doc, svBefore)`.
