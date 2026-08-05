package cmd

import "github.com/hanzei/jot/server/client"

type seedItem struct {
	text        string
	completed   bool
	indentLevel int
}

type seedNote struct {
	noteType              client.NoteType // "text" or "list"
	content               string          // text notes
	title                 string          // list notes
	color                 string
	pinned                bool
	archived              bool
	trashed               bool
	checkedItemsCollapsed bool
	items                 []seedItem
	labels                []string
	shareWith             []string // usernames to share this note with
	imageCount            int      // number of generated sample images to attach
}

type seedUser struct {
	username    string
	firstName   string
	lastName    string
	password    string
	theme       string
	noteSort    string
	language    string
	profileIcon bool
	notes       []seedNote
}

const (
	seedPassword    = "test"
	seedUsernameBob = "bob"
)

// seedDataset covers every valid theme (system/light/dark), every NoteSort
// (manual/updated_at/created_at), and a representative spread of note states.
var seedDataset = []seedUser{
	{
		username:    "alice",
		firstName:   "Alice",
		password:    seedPassword,
		theme:       "dark",
		noteSort:    "manual",
		language:    "en",
		profileIcon: true,
		notes: []seedNote{
			// active text notes (5)
			{
				noteType: client.NoteTypeText,
				content: "# Project Notes\n\n**Important:** Check the _deadline_ before Thursday.\n\n" +
					"Install with `npm install`:\n\n```bash\nnpm install\nnpm start\n```\n\n" +
					"See [the docs](https://example.com) for full reference.",
				labels:     []string{"work"},
				shareWith:  []string{seedUsernameBob},
				imageCount: 1, // banner
			},
			{
				noteType:  client.NoteTypeText,
				content:   "Pick up groceries on the way home",
				pinned:    true,
				labels:    []string{"personal"},
				shareWith: []string{seedUsernameBob},
			},
			{
				noteType:   client.NoteTypeText,
				content:    "Build a note-taking app with offline support and mobile sync",
				color:      "#aecbfa",
				labels:     []string{"ideas"},
				imageCount: 3, // grid
			},
			{
				noteType: client.NoteTypeText,
				content:  "Call dentist to reschedule appointment",
			},
			// Exercises the full text-note Markdown feature set (docs/specs/markdown-rendering.md
			// §2): every rendered construct plus every "shown as literal source" one, side by side.
			{
				noteType: client.NoteTypeText,
				content: "# Markdown Showcase\n\n" +
					"## Text formatting\n\n" +
					"**Bold**, *italic*, ~~strikethrough~~, and `inline code` all render inline. " +
					"Headings below h3, like this one, render as bold body text:\n\n#### Smaller heading\n\n" +
					"## Code block\n\n```bash\nnpm install\nnpm start\n```\n\n" +
					"## Lists\n\n- Bullet item\n- Another bullet\n\n1. Ordered item\n2. Another ordered item\n\n" +
					"- [ ] Unchecked task\n- [x] Checked task\n\n" +
					"## Quote and rule\n\n> A blockquote for context or a citation.\n\n---\n\n" +
					"## Links\n\n[Jot on GitHub](https://github.com/hanzei/jot), a bare https://example.com URL, " +
					"and a [mailto link](mailto:hello@example.com) all render live. " +
					"An unsupported scheme like [call me](tel:+15550100) stays plain text instead.\n\n" +
					"## Rendered as literal source\n\n" +
					"Images: ![diagram](https://example.com/diagram.png \"architecture\")\n\n" +
					"Tables:\n\na | b\n--- | ---\n1 | 2\n\n" +
					"Raw HTML: <b>bold</b> stays inert.\n\n" +
					"A single newline\nbecomes a line break.",
				labels: []string{"markdown"},
			},
			// active list notes (4)
			{
				noteType:   client.NoteTypeList,
				title:      "Sprint tasks",
				labels:     []string{"urgent"},
				shareWith:  []string{seedUsernameBob},
				imageCount: 2, // grid
				items: []seedItem{
					{text: "Review pull requests", completed: true},
					{text: "Update documentation", completed: false},
					{text: "Fix failing tests", completed: false},
				},
			},
			{
				noteType:              client.NoteTypeList,
				title:                 "Reading list",
				checkedItemsCollapsed: true,
				items: []seedItem{
					{text: "The Pragmatic Programmer", completed: true},
					{text: "Clean Code", completed: true},
					{text: "Designing Data-Intensive Applications", completed: false},
				},
			},
			{
				noteType: client.NoteTypeList,
				title:    "Groceries",
				items: []seedItem{
					{text: "Apples", completed: false},
					{text: "Bread", completed: false},
					{text: "Coffee", completed: true},
				},
			},
			{
				noteType:   client.NoteTypeList,
				title:      "Home renovation",
				color:      "#e6c9a8",
				imageCount: imageMaxPerNoteSeed, // at the per-note cap
				items: []seedItem{
					{text: "Kitchen"},
					{text: "Replace faucet", completed: true, indentLevel: 1},
					{text: "Paint cabinets", indentLevel: 1},
					{text: "Install backsplash", indentLevel: 1},
					{text: "Bathroom"},
					{text: "Re-grout tiles", completed: true, indentLevel: 1},
					{text: "Replace mirror", indentLevel: 1},
				},
			},
			// Exercises the list-item Markdown subset (docs/specs/markdown-rendering.md §2.1):
			// the same inline constructs as above, plus nesting, plus block syntax that stays
			// literal because an item already carries its own checkbox and level.
			{
				noteType: client.NoteTypeList,
				title:    "Markdown checklist",
				labels:   []string{"markdown"},
				items: []seedItem{
					{text: "**Bold** step one"},
					{text: "Nested reminder with **bold** and a `code` snippet", indentLevel: 1},
					{text: "*Italic* step two"},
					{text: "~~Skip this step~~", completed: true},
					{text: "Run `npm test` before merging"},
					{text: "See the [style guide](https://example.com)"},
					{text: "# Not a heading — block markdown stays literal in items"},
					{text: "- [ ] Not a checkbox — the item already has one"},
				},
			},
			// archived notes (3)
			{noteType: client.NoteTypeText, content: "Old meeting notes from Q3", archived: true},
			{noteType: client.NoteTypeText, content: "Draft blog post: Getting started with Go", archived: true},
			{
				noteType: client.NoteTypeList,
				title:    "Old shopping list",
				archived: true,
				items:    []seedItem{{text: "Milk"}, {text: "Eggs"}},
			},
			// trashed notes (3)
			{noteType: client.NoteTypeText, content: "Temporary scratch note", trashed: true},
			{noteType: client.NoteTypeText, content: "Draft email that was never sent", trashed: true},
			{
				noteType: client.NoteTypeList,
				title:    "Abandoned todo list",
				trashed:  true,
				items:    []seedItem{{text: "Task A"}, {text: "Task B"}},
			},
		},
	},
	{
		username:  seedUsernameBob,
		firstName: "Bob",
		lastName:  "Smith",
		password:  seedPassword,
		theme:     "light",
		noteSort:  "updated_at",
		language:  "de",
		notes: []seedNote{
			{noteType: client.NoteTypeText, content: "Work in progress: API design notes", labels: []string{"work"}},
			{noteType: client.NoteTypeText, content: "Team standup notes"},
			{noteType: client.NoteTypeText, content: "Monthly goals and OKRs"},
		},
	},
	{
		username:  "carol",
		firstName: "Carol",
		password:  seedPassword,
		theme:     "system",
		noteSort:  "created_at",
		language:  "fr",
		notes: []seedNote{
			{noteType: client.NoteTypeText, content: "Learning French vocabulary: bonjour, merci, au revoir"},
			{noteType: client.NoteTypeText, content: "Recipe: Quiche Lorraine\n\nIngredients: eggs, cream, bacon, gruyère"},
			{noteType: client.NoteTypeText, content: "Travel itinerary for Paris trip in July"},
		},
	},
}
