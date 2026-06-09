package cmd

import "github.com/hanzei/jot/server/client"

type seedItem struct {
	text      string
	completed bool
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

const seedPassword = "test"

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
			// active text notes (4)
			{
				noteType: client.NoteTypeText,
				content: "# Project Notes\n\n**Important:** Check the _deadline_ before Thursday.\n\n" +
					"Install with `npm install`:\n\n```bash\nnpm install\nnpm start\n```\n\n" +
					"See [the docs](https://example.com) for full reference.",
				labels:    []string{"work"},
				shareWith: []string{"bob"},
			},
			{
				noteType:  "text",
				content:   "Pick up groceries on the way home",
				pinned:    true,
				labels:    []string{"personal"},
				shareWith: []string{"bob"},
			},
			{
				noteType: client.NoteTypeText,
				content:  "Build a note-taking app with offline support and mobile sync",
				color:    "blue",
				labels:   []string{"ideas"},
			},
			{
				noteType: client.NoteTypeText,
				content:  "Call dentist to reschedule appointment",
			},
			// active list notes (3)
			{
				noteType:  "list",
				title:     "Sprint tasks",
				labels:    []string{"urgent"},
				shareWith: []string{"bob"},
				items: []seedItem{
					{text: "Review pull requests", completed: true},
					{text: "Update documentation", completed: false},
					{text: "Fix failing tests", completed: false},
				},
			},
			{
				noteType:              "list",
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
		username:  "bob",
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
