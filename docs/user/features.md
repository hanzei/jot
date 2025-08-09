# Jot Features Guide

This comprehensive guide covers all the features available in Jot and how to use them effectively.

## Core Features

### Note Types

#### Text Notes
Perfect for general note-taking, ideas, and free-form content.

**How to create:**
1. Click "New Note"
2. Select "Text" type
3. Add title and content
4. Save your note

**Best for:**
- Meeting notes
- Ideas and brainstorming
- General information
- Long-form content
- Research notes

#### Todo Lists
Interactive checklists for tasks and reminders.

**How to create:**
1. Click "New Note"
2. Select "Todo List" type
3. Add list title
4. Add individual items
5. Save your list

**Best for:**
- Daily tasks
- Project checklists
- Shopping lists
- Goal tracking
- Step-by-step processes

### Note Organization

#### Pinning Notes
Jot keeps important notes visible at the top of your list.

**How to pin:**
1. Click the three dots (⋮) on any note
2. Select "Pin"
3. Pinned notes appear with a blue dot indicator

**When to use:**
- Important reminders
- Frequently accessed information
- Current projects
- Daily/weekly goals

#### Color Coding
Use colors to categorize and organize your notes visually.

**Available colors:**
- **White** (Default): General notes
- **Yellow**: Reminders and important information
- **Green**: Completed tasks or positive notes
- **Blue**: Information and reference material
- **Red**: Urgent items and deadlines
- **Purple**: Creative projects and ideas

**How to change colors:**
1. Open note for editing
2. Click desired color circle at bottom
3. Save the note

#### Archiving
Hide completed or old notes without deleting them.

**How to archive:**
1. Click three dots (⋮) on note
2. Select "Archive"
3. View archived notes in "Archive" tab

**When to archive:**
- Completed projects
- Old meeting notes
- Reference material you rarely need
- Notes that clutter your main view

### Search and Discovery

#### Real-time Search
Find notes instantly as you type.

**Search features:**
- Searches both titles and content
- Works with todo list text
- Case-insensitive
- Instant results as you type

**Search tips:**
- Use specific keywords
- Try different variations of words
- Search for partial words
- Clear search to see all notes

#### Filtering
Switch between different views of your notes.

**Available filters:**
- **Notes tab**: Active notes only
- **Archive tab**: Archived notes only

## Advanced Features

### Todo List Management

#### Interactive Checkboxes
- Click checkboxes to mark items complete
- Completed items show strikethrough text
- Visual progress tracking

#### Item Management
- Add new items while editing
- Remove items with trash icon
- Reorder items by position
- Edit item text directly

### Note Editing

#### Rich Text Support
- Maintains line breaks and formatting
- Preserves spacing and structure
- Supports special characters

#### Auto-save Behavior
- Changes save when you click "Save"
- Unsaved changes are lost if you close modal
- No automatic saving (intentional for privacy)

### Visual Organization

#### Grid Layout
- Responsive design for all screen sizes
- Notes arranged by importance (pinned first)
- Recent notes appear earlier
- Color-coded for visual organization

#### Hover Interactions
- Note actions appear on hover
- Clean interface when not needed
- Quick access to common functions

## User Interface Guide

### Navigation

#### Header
- **Jot Logo**: Returns to main notes view
- **Notes/Archive Tabs**: Switch between views
- **Search Bar**: Find notes quickly
- **User Menu**: Shows email and logout option

#### Note Actions Menu
Access via three dots (⋮) on each note:
- **Edit**: Open note in edit modal
- **Pin/Unpin**: Toggle pin status
- **Archive/Unarchive**: Toggle archive status
- **Delete**: Permanently remove note

### Keyboard Shortcuts

While editing notes:
- **Tab**: Move between fields
- **Enter**: Submit forms
- **Escape**: Close modals
- **Ctrl/Cmd + Enter**: Save note (browser dependent)

## Security and Privacy

### Authentication
- Secure email/password login
- JWT tokens for session management
- 24-hour token expiration
- Automatic logout on expiration

### Data Protection
- All notes are private to your account
- No sharing between users (privacy-first)
- Secure password hashing
- Local SQLite database storage

### Session Management
- Automatic logout after token expires
- Manual logout available anytime
- Session survives browser refresh
- Secure token storage in browser

## Mobile and Responsive Design

### Mobile Features
- Touch-friendly interface
- Responsive grid layout
- Mobile-optimized forms
- Swipe-friendly interactions

### Cross-Device Usage
- Works on phones, tablets, desktops
- Consistent experience across devices
- Responsive design adapts to screen size
- Touch and mouse input supported

## Performance Features

### Fast Loading
- Single-page application (SPA)
- Quick navigation between views
- Efficient data loading
- Minimal server requests

### Offline Considerations
- Requires internet connection
- Real-time updates from server
- No offline functionality (by design)
- Fast reconnection after network issues

## Limitations and Considerations

### Current Limitations
- No note sharing between users
- No collaborative editing
- No file attachments
- No note history/versioning
- No export functionality
- No note templates

### Design Decisions
These limitations are intentional for:
- **Simplicity**: Easy to use and maintain
- **Privacy**: Complete data ownership
- **Performance**: Fast and lightweight
- **Security**: Minimal attack surface

## Tips for Power Users

### Workflow Optimization
1. **Use consistent color coding** for different project types
2. **Pin active projects** to keep them visible
3. **Archive regularly** to maintain clean workspace
4. **Use descriptive titles** for better searchability
5. **Create template-like notes** for repeated tasks

### Organization Strategies
1. **Daily notes**: Create daily todo lists with consistent naming
2. **Project separation**: Use colors to separate work/personal
3. **Reference notes**: Store important info in pinned notes
4. **Review routine**: Regularly archive completed items
5. **Search habits**: Use search instead of scrolling for large note collections

---

Master these features to become a Jot power user! 🚀