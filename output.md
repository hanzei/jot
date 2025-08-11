### Goal

Implement real-time functionality using WebSockets for the "Jot" application. When a user creates, updates, or deletes a note, the changes should be broadcast to all other connected clients, and their UI should update automatically without needing a page refresh.

### Backend Implementation (Go)

The backend needs a WebSocket hub to manage client connections and broadcast messages when notes are modified.

**1. Add WebSocket Dependency:**
First, add the `gorilla/websocket` package to the project.
```bash
go get github.com/gorilla/websocket
```

**2. Create WebSocket Hub and Client Logic:**
Create a new package `internal/ws` for handling WebSocket logic.

*   **File: `internal/ws/hub.go`**
    *   Define a `Hub` struct. This struct will maintain a set of active clients and broadcast messages to them.
    *   It should have channels for registering clients, unregistering clients, and broadcasting messages.
    *   Implement a `Run()` method that runs in a goroutine to handle these channels.

*   **File: `internal/ws/client.go`**
    *   Define a `Client` struct. This represents a single connected user.
    *   It should contain the `websocket.Conn`, a reference to the `Hub`, and a `send` channel for outbound messages.
    *   Implement a `readPump()` method to read messages from the WebSocket connection (if needed for client-to-server communication beyond HTTP).
    *   Implement a `writePump()` method to write messages from the `send` channel to the WebSocket connection.

*   **File: `internal/ws/message.go`**
    *   Define the structure for messages sent over the WebSocket. This ensures consistency between the frontend and backend.
    ```go
    package ws

    type Message struct {
        Type    string      `json:"type"`
        Payload interface{} `json:"payload"`
    }
    ```
    *   Common types will be `NOTE_CREATED`, `NOTE_UPDATED`, and `NOTE_DELETED`.

**3. Create WebSocket HTTP Handler:**
Create a new handler to upgrade HTTP requests to WebSocket connections.

*   **File: `internal/handlers/ws.go`**
    *   Create a `ServeWs(hub *ws.Hub, w http.ResponseWriter, r *http.Request)` function.
    *   This handler will use `websocket.Upgrader` to upgrade the connection.
    *   On successful upgrade, it will create a new `ws.Client`, register it with the hub, and start its `readPump` and `writePump` goroutines.

**4. Integrate with the Server and Note Handlers:**

*   **File: `main.go` (or wherever the server is initialized)**
    *   Instantiate the `Hub` and run it in a background goroutine:
        ```go
        hub := ws.NewHub()
        go hub.Run()
        ```
    *   Register the new WebSocket endpoint, passing the hub to the handler:
        ```go
        http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
            handlers.ServeWs(hub, w, r)
        })
        ```

*   **File: `internal/handlers/notes.go`**
    *   Modify the existing note handlers (`CreateNote`, `UpdateNote`, `DeleteNote`) to broadcast changes.
    *   The handlers need access to the `Hub` instance.
    *   After a successful database operation, create a `ws.Message` and broadcast it.

    *   **Example for `CreateNote`:**
        ```go
        // ... after successfully saving the note to the database ...
        msg := ws.Message{Type: "NOTE_CREATED", Payload: newNote}
        h.hub.Broadcast <- msg // Assuming the handler has access to the hub `h.hub`
        // ... respond with HTTP JSON as before ...
        ```
    *   Do the same for `UpdateNote` (with type `NOTE_UPDATED`) and `DeleteNote` (with type `NOTE_DELETED`, payload could be the note ID).

### Frontend Implementation (React)

The frontend needs to connect to the WebSocket server, listen for messages, and update its state accordingly.

**1. Create a WebSocket Service/Context:**
To manage the connection cleanly, create a React Context to provide the WebSocket functionality to the component tree.

*   **File: `src/contexts/WebSocketContext.tsx`**
    *   Create a `WebSocketContext`.
    *   Create a `WebSocketProvider` component.
    *   Inside the provider, use a `useEffect` hook to establish and maintain the WebSocket connection to `ws://<your_server_address>/ws`.
    *   The provider should handle `onopen`, `onclose`, and `onmessage` events.
    *   The most important part is the `onmessage` handler. It should parse the incoming JSON message and update the application's state.

**2. Integrate with Application State:**
The `WebSocketProvider` needs to trigger state updates. This example assumes you have a state management solution (like Zustand, Redux, or a parent component's state) for your notes.

*   **Inside `WebSocketProvider`'s `onmessage` handler:**
    ```typescript
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const { type, payload } = message;

      // Assuming you have a 'notes' state and a 'setNotes' function
      if (type === 'NOTE_CREATED') {
        setNotes(currentNotes => [...currentNotes, payload]);
      } else if (type === 'NOTE_UPDATED') {
        setNotes(currentNotes =>
          currentNotes.map(note => (note.id === payload.id ? payload : note))
        );
      } else if (type === 'NOTE_DELETED') {
        // Assuming payload is the ID of the deleted note
        setNotes(currentNotes =>
          currentNotes.filter(note => note.id !== payload.id)
        );
      }
    };
    ```

**3. Wrap the Application with the Provider:**

*   **File: `src/App.tsx` or `src/main.tsx`**
    *   Wrap your main application component (likely the one containing the `Dashboard`) with the `WebSocketProvider` so that any child component can access the real-time data.

    ```tsx
    <WebSocketProvider>
      <Dashboard />
    </WebSocketProvider>
    ```

**4. Update UI Components:**
Your existing components, like `Dashboard.tsx`, should already be getting their notes from the application state. Because the `WebSocketProvider` now updates that central state, the components will automatically re-render with the new data without any further changes.

### Summary of Outcome

*   The Go backend will have a `/ws` endpoint.
*   The backend will broadcast `NOTE_CREATED`, `NOTE_UPDATED`, and `NOTE_DELETED` messages to all clients when a note is changed.
*   The React frontend will connect to the `/ws` endpoint.
*   The UI will update in real-time for all users when any user makes a change to a note.
