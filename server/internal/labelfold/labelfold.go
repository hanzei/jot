// Package labelfold defines the case-folding rule for label names.
//
// Label names are unique per user without regard to case. That rule used to be
// enforced in SQL, which capped it at ASCII A-Z: SQLite's LOWER() and COLLATE
// NOCASE fold nothing outside that range and cannot be made Unicode-aware
// without the ICU extension, so PostgreSQL was pinned down to match. The rule
// now lives here instead, and each row carries its folded name in
// labels.name_folded, so both backends enforce Unicode-correct folding by
// comparing a plain column.
//
// This package is the single definition of the rule. Nothing in either schema
// can check that a caller folded consistently, so every write of name_folded —
// in the stores and in the backfill that populates existing rows — must go
// through Fold. It deliberately depends on nothing inside the server so both
// internal/models and internal/database can import it.
package labelfold

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// folder is safe to share: unlike Caser values generally, the one returned by
// cases.Fold is documented as stateless and usable from multiple goroutines.
var folder = cases.Fold()

// Fold returns the case-folded key for a label name. Two names collide when
// their folded forms are equal.
//
// Names are normalized to NFC first, so the two ways Unicode can spell "Café" —
// precomposed é, or e followed by a combining acute — fold to the same key.
// Case folding then handles the cases simple lower-casing misses: Greek final
// sigma ("ΣΟΦΟΣ" and "σοφος") and German sharp s ("Straße" and "STRASSE").
func Fold(name string) string {
	return folder.String(norm.NFC.String(name))
}
