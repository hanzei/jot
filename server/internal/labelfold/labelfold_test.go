package labelfold

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFold(t *testing.T) {
	t.Run("names that must collide", func(t *testing.T) {
		tests := []struct {
			name string
			a, b string
		}{
			{"ascii case", "Work", "work"},
			{"ascii upper", "WORK", "work"},
			{"german umlaut", "Äpfel", "äpfel"},
			{"german umlaut upper", "ÄPFEL", "äpfel"},
			{"french accent", "Épée", "épée"},
			{"german sharp s", "Straße", "STRASSE"},
			{"greek final sigma", "ΣΟΦΟΣ", "σοφος"},
			{"nfd and nfc", "Café", "Café"},
			{"nfd and nfc mixed case", "CAFÉ", "café"},
			{"polish", "Łódź", "łódź"},
			{"turkish dotted i", "İstanbul", "i̇stanbul"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				assert.Equal(t, Fold(tt.a), Fold(tt.b),
					"%q and %q must fold to the same key", tt.a, tt.b)
			})
		}
	})

	t.Run("names that must stay distinct", func(t *testing.T) {
		tests := []struct {
			name string
			a, b string
		}{
			{"different words", "Work", "Home"},
			{"accent is not stripped", "Äpfel", "Apfel"},
			{"accent is not stripped french", "Épée", "Epee"},
			{"substring", "Work", "Workshop"},
			{"underscore is literal", "in_progress", "inXprogress"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				assert.NotEqual(t, Fold(tt.a), Fold(tt.b),
					"%q and %q must not fold to the same key", tt.a, tt.b)
			})
		}
	})

	t.Run("is idempotent", func(t *testing.T) {
		for _, name := range []string{"Äpfel", "Straße", "ΣΟΦΟΣ", "Café", "Work", ""} {
			assert.Equal(t, Fold(name), Fold(Fold(name)),
				"folding %q twice must equal folding it once", name)
		}
	})

	t.Run("empty and whitespace pass through", func(t *testing.T) {
		assert.Empty(t, Fold(""))
		assert.Equal(t, " ", Fold(" "))
	})
}
