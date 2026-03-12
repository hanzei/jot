# Phase 6 — Drag-and-Drop Reorder

## Goal

Enable drag-to-reorder for notes on the Notes List screen and for todo items inside the note editor. At the end of this phase users can organize their notes and todo items by dragging them into the desired order.

---

## Prerequisites

- Phase 2 complete (notes list, note editor with todo items)

---

## What to Build

### 1. Dependencies

| Package | Purpose |
|---------|---------|
| `react-native-gesture-handler` | Gesture recognition |
| `react-native-reanimated` | Smooth drag animations |
| `react-native-draggable-flatlist` | Draggable list component (built on gesture-handler + reanimated) |

These require a **development build** (not Expo Go). Configure via `expo prebuild` or EAS Build.

Add the `react-native-reanimated` Babel plugin to `babel.config.js`:
```js
plugins: ['react-native-reanimated/plugin']
```

### 2. Notes List Reorder

Replace the `FlatList` in `NotesListScreen` with `DraggableFlatList` from `react-native-draggable-flatlist`:

- Long-press activates drag mode (the card lifts with a scale/shadow animation)
- Dragging reorders cards within the same section (pinned or unpinned)
- On drop, send the new order to `POST /api/v1/notes/reorder`
- The reorder payload is an array of note IDs in their new position order
- Optimistically update the local list order; revert on API error
- Pinned and unpinned notes are reordered independently (two separate `DraggableFlatList` instances, or a single list with section-locked drag zones)

**Interaction with context menu:** Since both long-press triggers the context menu (Phase 3) and drag, differentiate between them:
- Option A: Long-press starts drag; context menu is accessed via a three-dot menu icon on the card
- Option B: Short long-press (200ms) opens context menu; continued hold (500ms+) enters drag mode
- Recommend **Option A** — it's clearer and avoids gesture conflicts

### 3. Todo Item Reorder

In the Note Editor (todo mode), make the todo item list draggable:

- Add a drag handle icon (grip dots) to the left of each `TodoItem`
- Pressing the drag handle activates drag mode for that item
- Reorder is local-only during editing; the new item positions are included in the next auto-save (`PUT /api/v1/notes/{id}` with updated `items` array including `position` values)
- Only uncompleted items are draggable; completed items stay in the collapsed section

### 4. Haptic Feedback

Add `expo-haptics` for tactile feedback:
- Light impact on drag start
- Medium impact on drop

---

## Server Endpoints Consumed

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/notes/reorder` | Persist new note order |
| PUT | `/api/v1/notes/{id}` | Save todo item order (via items array in note update) |

---

## Acceptance Criteria

- [ ] Long-pressing a note card (or drag handle) initiates a drag
- [ ] Dragging a card reorders it among its peers (pinned with pinned, unpinned with unpinned)
- [ ] Dropping a card persists the new order to the server
- [ ] Reorder is optimistic — the new order appears immediately, reverts on error
- [ ] Todo items in the editor have drag handles
- [ ] Dragging a todo item reorders it among uncompleted items
- [ ] Todo item reorder is saved on the next auto-save
- [ ] Haptic feedback on drag start and drop
- [ ] Gesture interactions don't conflict with scrolling or tap/long-press actions
