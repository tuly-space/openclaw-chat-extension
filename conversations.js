/**
 * conversations.js — Local conversation store (chrome.storage.local)
 *
 * Index key: 'oc_convs'   → [{id, title, updatedAt}]
 * Data key:  'oc_conv_<id>' → {id, title, createdAt, updatedAt, messages:[{role,content}]}
 */

const INDEX_KEY = 'oc_convs'
const PREFIX = 'oc_conv_'

function convKey(id) { return PREFIX + id }

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function titleFromMessage(content) {
  return String(content || '').trim().slice(0, 60) || 'New conversation'
}

/** List all conversations (summary only, newest first) */
export async function listConversations() {
  const s = await chrome.storage.local.get(INDEX_KEY)
  const index = s[INDEX_KEY] || []
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Load a full conversation including messages */
export async function loadConversation(id) {
  const s = await chrome.storage.local.get(convKey(id))
  return s[convKey(id)] || null
}

/** Create a new empty conversation, return it */
export async function createConversation() {
  const id = genId()
  const now = Date.now()
  const conv = { id, title: 'New conversation', createdAt: now, updatedAt: now, messages: [] }
  await saveConversation(conv)
  return conv
}

/** Save/update a full conversation object */
export async function saveConversation(conv) {
  const now = Date.now()
  conv.updatedAt = now

  // Update full data
  await chrome.storage.local.set({ [convKey(conv.id)]: conv })

  // Update index
  const s = await chrome.storage.local.get(INDEX_KEY)
  const index = s[INDEX_KEY] || []
  const existing = index.findIndex(c => c.id === conv.id)
  const summary = { id: conv.id, title: conv.title, updatedAt: conv.updatedAt }
  if (existing >= 0) index[existing] = summary
  else index.push(summary)
  await chrome.storage.local.set({ [INDEX_KEY]: index })
}

/** Append a message to a conversation; auto-title from first user message */
export async function appendMessage(conv, role, content) {
  conv.messages.push({ role, content })
  if (conv.title === 'New conversation' && role === 'user') {
    conv.title = titleFromMessage(content)
  }
  await saveConversation(conv)
}

/** Delete a conversation */
export async function deleteConversation(id) {
  await chrome.storage.local.remove(convKey(id))
  const s = await chrome.storage.local.get(INDEX_KEY)
  const index = (s[INDEX_KEY] || []).filter(c => c.id !== id)
  await chrome.storage.local.set({ [INDEX_KEY]: index })
}
