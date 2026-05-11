const express = require('express');
const Y = require('yjs');
const { io } = require('socket.io-client');

const app = express();
app.use(express.json());

const AFFINE_URL    = process.env.AFFINE_URL    || 'https://affine.avernus.cloud';
const TOKEN         = process.env.AFFINE_TOKEN;
const WORKSPACE_ID  = process.env.AFFINE_WORKSPACE_ID;
const TODO_DOC_ID   = process.env.AFFINE_TODO_DOC_ID; // optional – fixed inbox page

if (!TOKEN || !WORKSPACE_ID) {
  console.error('AFFINE_TOKEN and AFFINE_WORKSPACE_ID are required');
  process.exit(1);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function genId(len = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function fetchDocBinary(docId) {
  const res = await fetch(`${AFFINE_URL}/api/workspaces/${WORKSPACE_ID}/docs/${docId}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`fetchDoc ${docId} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// Push a Yjs update via Socket.IO (the protocol the AFFiNE client uses)
async function pushUpdate(docId, updateBuffer) {
  return new Promise((resolve, reject) => {
    let socket;

    const fail = msg => {
      if (socket) socket.disconnect();
      reject(new Error(msg));
    };

    const timer = setTimeout(() => fail('Socket.IO push timed out after 15s'), 15_000);

    socket = io(AFFINE_URL, {
      transports: ['websocket'],
      auth: { token: TOKEN },
      extraHeaders: { 'Authorization': `Bearer ${TOKEN}` },
    });

    socket.on('connect_error', err => {
      clearTimeout(timer);
      fail(`Socket connect error: ${err.message}`);
    });

    socket.on('connect', () => {
      console.log('[socket] connected, sid:', socket.id);

      // Try different payload shapes until one succeeds
      const joinPayloads = [
        { spaceId: WORKSPACE_ID, spaceType: 'workspace' },
        { spaceId: WORKSPACE_ID },
        { workspaceId: WORKSPACE_ID },
      ];

      const tryJoin = (idx = 0) => {
        if (idx >= joinPayloads.length) {
          clearTimeout(timer);
          return fail('space:join failed with all payload variants');
        }
        const payload = joinPayloads[idx];
        console.log('[socket] trying space:join:', JSON.stringify(payload));
        socket.emit('space:join', payload, joinRes => {
          console.log('[socket] space:join response:', JSON.stringify(joinRes));
          const ok = joinRes?.success ?? joinRes?.data?.success;
          if (ok === false || joinRes?.error) return tryJoin(idx + 1);

          socket.emit(
            'space:push-doc-update',
            { spaceId: WORKSPACE_ID, spaceType: 'workspace', docId, updates: updateBuffer },
            pushRes => {
              console.log('[socket] push response:', JSON.stringify(pushRes));
              clearTimeout(timer);
              socket.disconnect();
              if (pushRes?.error) reject(new Error(`push failed: ${JSON.stringify(pushRes)}`));
              else resolve(pushRes);
            },
          );
        });
      };

      tryJoin();
    });
  });
}

// ─── Yjs helpers ────────────────────────────────────────────────────────────

function makeTodoBlock(id, text) {
  const block = new Y.Map();
  block.set('sys:id', id);
  block.set('sys:flavour', 'affine:list');
  block.set('sys:version', 1);
  block.set('sys:children', new Y.Array());
  block.set('prop:type', 'todo');
  const yText = new Y.Text();
  yText.insert(0, text);
  block.set('prop:text', yText);
  block.set('prop:checked', false);
  block.set('prop:collapsed', false);
  return block;
}

// Create a brand-new AFFiNE page doc from scratch
function buildNewPageDoc(pageTitle, todos) {
  const doc   = new Y.Doc();
  const blocks = doc.getMap('blocks');

  const pageId = genId();
  const noteId = genId();

  // affine:page – root block
  const page = new Y.Map();
  page.set('sys:id', pageId);
  page.set('sys:flavour', 'affine:page');
  page.set('sys:version', 2);
  const pageChildren = new Y.Array();
  pageChildren.push([noteId]);
  page.set('sys:children', pageChildren);
  const titleText = new Y.Text();
  titleText.insert(0, pageTitle);
  page.set('prop:title', titleText);
  blocks.set(pageId, page);

  // affine:note – editable container
  const note = new Y.Map();
  note.set('sys:id', noteId);
  note.set('sys:flavour', 'affine:note');
  note.set('sys:version', 1);
  const noteChildren = new Y.Array();
  note.set('sys:children', noteChildren);
  note.set('prop:background', '--affine-background-secondary-color');
  note.set('prop:index', 'a0');
  note.set('prop:hidden', false);
  note.set('prop:displayMode', 'both');
  blocks.set(noteId, note);

  // todo blocks
  todos.forEach(text => {
    const id = genId();
    blocks.set(id, makeTodoBlock(id, text));
    noteChildren.push([id]);
  });

  return {
    docId:  pageId,
    update: Y.encodeStateAsUpdate(doc),
  };
}

// Append todo blocks to an existing AFFiNE page
async function appendTodosToDoc(docId, todos) {
  console.log('[appendTodos] fetching doc:', docId);
  const existing = await fetchDocBinary(docId);
  console.log('[appendTodos] doc fetched, bytes:', existing.length);

  const doc = new Y.Doc();
  Y.applyUpdate(doc, existing);
  const svBefore = Y.encodeStateVector(doc); // snapshot before our changes

  const blocks = doc.getMap('blocks');

  // Find the first affine:note block (editable area)
  let noteBlock = null;
  blocks.forEach(block => {
    if (!noteBlock && block instanceof Y.Map && block.get('sys:flavour') === 'affine:note') {
      noteBlock = block;
    }
  });
  if (!noteBlock) throw new Error('No affine:note block found in doc');

  const noteChildren = noteBlock.get('sys:children');
  todos.forEach(text => {
    const id = genId();
    blocks.set(id, makeTodoBlock(id, text));
    noteChildren.push([id]);
  });

  const diff = Y.encodeStateAsUpdate(doc, svBefore);
  await pushUpdate(docId, diff);
  return docId;
}

// ─── routes ─────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// POST /todo  { title, description?, emailFrom?, emailDate? }
app.post('/todo', async (req, res) => {
  try {
    console.log('[/todo] request body:', JSON.stringify(req.body));
    console.log('[/todo] TODO_DOC_ID:', TODO_DOC_ID || '(not set)');
    const { title, description, emailFrom, emailDate } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    // Build the text shown in AFFiNE: title + optional source line
    const lines = [title];
    if (description && description !== title) lines.push(`  → ${description}`);
    if (emailFrom) lines.push(`  📧 ${emailFrom}`);
    const todoText = lines.join('\n');

    let docId;
    let mode;

    if (TODO_DOC_ID) {
      // Append to a fixed "inbox" page
      docId = await appendTodosToDoc(TODO_DOC_ID, [todoText]);
      mode  = 'append';
    } else {
      // Create a new dated page
      const date  = (emailDate || new Date().toISOString()).slice(0, 10);
      const title = `Email Todos – ${date}`;
      const built = buildNewPageDoc(title, [todoText]);
      await pushUpdate(built.docId, built.update);
      docId = built.docId;
      mode  = 'new-page';
    }

    res.json({
      ok: true,
      mode,
      docId,
      url: `${AFFINE_URL}/workspace/${WORKSPACE_ID}/${docId}`,
    });
  } catch (err) {
    console.error('[/todo] FULL ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () =>
  console.log(`affine-todo-bridge listening on :3000  (workspace ${WORKSPACE_ID})`),
);
