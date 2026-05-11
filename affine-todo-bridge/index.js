const express = require('express');
const Y = require('yjs');
const { io } = require('socket.io-client');

const app = express();
app.use(express.json());

const AFFINE_URL    = process.env.AFFINE_URL    || 'https://affine.avernus.cloud';
const TOKEN         = process.env.AFFINE_TOKEN;
const WORKSPACE_ID  = process.env.AFFINE_WORKSPACE_ID;
const TODO_DOC_ID   = process.env.AFFINE_TODO_DOC_ID;
const AFFINE_EMAIL  = process.env.AFFINE_EMAIL;
const AFFINE_PASS   = process.env.AFFINE_PASSWORD;

if (!WORKSPACE_ID) {
  console.error('AFFINE_WORKSPACE_ID is required');
  process.exit(1);
}

// Session cookie obtained via email/password login (more reliable for Socket.IO)
let sessionCookie = null;

async function ensureSession() {
  if (sessionCookie) return;
  if (!AFFINE_EMAIL || !AFFINE_PASS) return;
  try {
    const res = await fetch(`${AFFINE_URL}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: AFFINE_EMAIL, password: AFFINE_PASS }),
    });
    // Node 18+ uses getSetCookie() for multiple set-cookie headers
    const all = (res.headers.getSetCookie?.() || []).join('; ') || res.headers.get('set-cookie') || '';
    const match = all.match(/affine_session=([^;,\s]+)/);
    if (match) {
      sessionCookie = match[1];
      console.log('[auth] session cookie obtained');
    } else {
      console.error('[auth] sign-in failed — status:', res.status, 'cookies:', all.slice(0, 100));
    }
  } catch (err) {
    console.error('[auth] sign-in error:', err.message);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function genId(len = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function fetchDocBinary(docId) {
  await ensureSession();
  const headers = {};
  if (sessionCookie) headers['Cookie'] = `affine_session=${sessionCookie}`;
  else if (TOKEN)    headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${AFFINE_URL}/api/workspaces/${WORKSPACE_ID}/docs/${docId}`, { headers });
  if (!res.ok) throw new Error(`fetchDoc ${docId} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// Push a Yjs update via Socket.IO (the protocol the AFFiNE client uses)
async function pushUpdate(docId, updateBuffer) {
  await ensureSession();
  return new Promise((resolve, reject) => {
    let socket;

    const fail = msg => {
      if (socket) socket.disconnect();
      reject(new Error(msg));
    };

    const timer = setTimeout(() => fail('Socket.IO push timed out after 15s'), 15_000);

    const cookieHeader = sessionCookie ? `affine_session=${sessionCookie}` : null;

    socket = io(AFFINE_URL, {
      transports: ['websocket'],
      withCredentials: true,
      extraHeaders: cookieHeader ? { cookie: cookieHeader } : undefined,
    });

    socket.on('connect_error', err => {
      clearTimeout(timer);
      fail(`Socket connect error: ${err.message}`);
    });

    socket.on('connect', async () => {
      try {
        const joinRes = await socket.emitWithAck('space:join', {
          spaceType: 'workspace',
          spaceId:   WORKSPACE_ID,
          clientVersion: '0.26.0',
        });
        if (!joinRes?.data?.success) {
          clearTimeout(timer);
          return fail(`space:join failed: ${JSON.stringify(joinRes)}`);
        }

        const pushRes = await socket.emitWithAck('space:push-doc-update', {
          spaceType: 'workspace',
          spaceId:   WORKSPACE_ID,
          docId,
          update:    Buffer.from(updateBuffer).toString('base64'),
        });
        clearTimeout(timer);
        socket.disconnect();
        if (pushRes?.error) reject(new Error(`push failed: ${JSON.stringify(pushRes)}`));
        else resolve(pushRes);
      } catch (err) {
        clearTimeout(timer);
        fail(`Socket operation error: ${err.message}`);
      }
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
  todos.forEach(({ text, subItems = [] }) => {
    const id = genId();
    const block = makeTodoBlock(id, text);
    if (subItems.length > 0) {
      const childArr = block.get('sys:children');
      subItems.forEach(subText => {
        const subId = genId();
        blocks.set(subId, makeTodoBlock(subId, subText));
        childArr.push([subId]);
      });
    }
    blocks.set(id, block);
    noteChildren.push([id]);
  });

  return {
    docId:  pageId,
    update: Y.encodeStateAsUpdate(doc),
  };
}

// Append todo blocks under the "Email Todos" h2 in an existing AFFiNE page.
// Creates the h2 if it doesn't exist yet.
async function appendTodosToDoc(docId, todos) {
  const existing = await fetchDocBinary(docId);

  const doc = new Y.Doc();
  Y.applyUpdate(doc, existing);
  const svBefore = Y.encodeStateVector(doc);

  const blocks = doc.getMap('blocks');

  // Find affine:note (editable area)
  let noteBlock = null;
  blocks.forEach(block => {
    if (!noteBlock && block instanceof Y.Map && block.get('sys:flavour') === 'affine:note') {
      noteBlock = block;
    }
  });
  if (!noteBlock) throw new Error('No affine:note block found in doc');

  const noteChildren = noteBlock.get('sys:children');

  // Look for an existing "Email Todos" h2 paragraph
  let hasH2 = false;
  for (let i = 0; i < noteChildren.length; i++) {
    const child = blocks.get(noteChildren.get(i));
    if (
      child instanceof Y.Map &&
      child.get('sys:flavour') === 'affine:paragraph' &&
      child.get('prop:type') === 'h2' &&
      child.get('prop:text')?.toString() === 'Email Todos'
    ) {
      hasH2 = true;
      break;
    }
  }

  // Create the h2 heading if missing
  if (!hasH2) {
    const h2Id = genId();
    const h2 = new Y.Map();
    h2.set('sys:id', h2Id);
    h2.set('sys:flavour', 'affine:paragraph');
    h2.set('sys:version', 1);
    h2.set('sys:children', new Y.Array());
    h2.set('prop:type', 'h2');
    const h2Text = new Y.Text();
    h2Text.insert(0, 'Email Todos');
    h2.set('prop:text', h2Text);
    h2.set('prop:collapsed', false);
    blocks.set(h2Id, h2);
    noteChildren.push([h2Id]);
  }

    // Find insert position: end of the "Email Todos" section (before any following h2)
  let insertAt = noteChildren.length - 1; // default: end of note
  let inSection = false;
  for (let i = 0; i < noteChildren.length; i++) {
    const child = blocks.get(noteChildren.get(i));
    if (!(child instanceof Y.Map)) continue;
    if (child.get('sys:flavour') === 'affine:paragraph' && child.get('prop:type') === 'h2') {
      const txt = child.get('prop:text')?.toString();
      if (txt === 'Email Todos') { inSection = true; insertAt = i; continue; }
      if (inSection) { insertAt = i - 1; break; }
    } else if (inSection) {
      insertAt = i;
    }
  }

  // Append todos right after the last item in the section
  todos.forEach(({ text, subItems = [] }) => {
    const id = genId();
    const block = makeTodoBlock(id, text);
    // Add sub-items as children
    if (subItems.length > 0) {
      const childArr = block.get('sys:children');
      subItems.forEach(subText => {
        const subId = genId();
        blocks.set(subId, makeTodoBlock(subId, subText));
        childArr.push([subId]);
      });
    }
    blocks.set(id, block);
    insertAt++;
    noteChildren.insert(insertAt, [id]);
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
    const { title, subItems = [], emailDate } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const parsedSubItems = Array.isArray(subItems) ? subItems : [];

    let docId;
    let mode;

    if (TODO_DOC_ID) {
      docId = await appendTodosToDoc(TODO_DOC_ID, [{ text: title, subItems: parsedSubItems }]);
      mode  = 'append';
    } else {
      const date  = (emailDate || new Date().toISOString()).slice(0, 10);
      const built = buildNewPageDoc(`Email Todos – ${date}`, [{ text: title, subItems: parsedSubItems }]);
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
    console.error('[/todo]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () =>
  console.log(`affine-todo-bridge listening on :3000  (workspace ${WORKSPACE_ID})`),
);
