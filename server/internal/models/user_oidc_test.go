package models

import (
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	testIssuer  = "https://idp.example.com"
	testSubject = "subject-abc-123"
)

func TestProvisionSSOUser(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		ctx := t.Context()

		t.Run("first user is admin only when admin bootstrap is allowed", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			// grantAdminIfFirst=false mirrors a mixed-mode deployment (local login
			// enabled): the first SSO user is still a plain user.
			u, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "alice", false)
			require.NoError(t, err)
			assert.Equal(t, RoleUser, u.Role)
			assert.Equal(t, "alice", u.Username)
		})

		t.Run("first user is admin under SSO-only bootstrap", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			u, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "alice", true)
			require.NoError(t, err)
			assert.Equal(t, RoleAdmin, u.Role)

			// A second SSO user under the same bootstrap flag is a plain user.
			u2, err := store.ProvisionSSOUser(ctx, testIssuer, "subject-two", "bob", true)
			require.NoError(t, err)
			assert.Equal(t, RoleUser, u2.Role)
		})

		t.Run("returned user reports the SSO link like a fresh read", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			u, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "alice", false)
			require.NoError(t, err)
			assert.True(t, u.HasSSOLinked)
			assert.False(t, u.HasPassword)

			fetched, err := store.GetByID(ctx, u.ID)
			require.NoError(t, err)
			assert.Equal(t, fetched.HasSSOLinked, u.HasSSOLinked)
			assert.Equal(t, fetched.HasPassword, u.HasPassword)
		})

		t.Run("has no local password", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			u, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "alice", false)
			require.NoError(t, err)

			fetched, err := store.GetByID(ctx, u.ID)
			require.NoError(t, err)
			assert.Empty(t, fetched.PasswordHash, "SSO-provisioned user has a NULL password_hash")
			assert.False(t, fetched.CheckPassword("anything"), "a NULL hash never authenticates")
		})

		t.Run("username is de-duplicated on collision", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			// A local user already holds "alice".
			_, err := store.Create(ctx, "alice", "password123")
			require.NoError(t, err)

			u2, err := store.ProvisionSSOUser(ctx, testIssuer, "sub-2", "alice", false)
			require.NoError(t, err)
			assert.Equal(t, "alice-2", u2.Username)

			u3, err := store.ProvisionSSOUser(ctx, testIssuer, "sub-3", "alice", false)
			require.NoError(t, err)
			assert.Equal(t, "alice-3", u3.Username)
		})

		t.Run("username seed is sanitized to the allowed character set", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			// An email-shaped claim: the local-part survives, '@' and domain do not.
			u, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "Alice.Smith@example.com", false)
			require.NoError(t, err)
			assert.Equal(t, "alicesmithexamplecom", u.Username)
		})

		t.Run("de-duplicated username stays within the length limit", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			base := strings.Repeat("a", 30) // already at the 30-char limit
			_, err := store.Create(ctx, base, "password123")
			require.NoError(t, err)

			u, err := store.ProvisionSSOUser(ctx, testIssuer, "sub-long", base, false)
			require.NoError(t, err)
			assert.LessOrEqual(t, len(u.Username), 30, "suffixed username must not exceed the 30-char limit")
			assert.True(t, strings.HasSuffix(u.Username, "-2"), "got %q", u.Username)
		})
	})
}

func TestGetByOIDCIdentity(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestUserStore(t, driver)
		ctx := t.Context()

		_, err := store.GetByOIDCIdentity(ctx, testIssuer, testSubject)
		require.ErrorIs(t, err, ErrUserNotFound)

		provisioned, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "alice", false)
		require.NoError(t, err)

		found, err := store.GetByOIDCIdentity(ctx, testIssuer, testSubject)
		require.NoError(t, err)
		assert.Equal(t, provisioned.ID, found.ID)

		// A different subject at the same issuer does not match.
		_, err = store.GetByOIDCIdentity(ctx, testIssuer, "other-subject")
		require.ErrorIs(t, err, ErrUserNotFound)
	})
}

func TestOIDCIdentityUniqueness(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestUserStore(t, driver)
		ctx := t.Context()

		// Two local accounts.
		alice, err := store.Create(ctx, "alice", "password123")
		require.NoError(t, err)
		bob, err := store.Create(ctx, "bob", "password123")
		require.NoError(t, err)

		// Many local-only users (both OIDC columns NULL) coexist — the unique
		// index must not reject them.
		require.NoError(t, err, "two local users with NULL OIDC columns are allowed")

		require.NoError(t, store.LinkOIDCIdentity(ctx, alice.ID, testIssuer, testSubject))

		// Binding the same (issuer, subject) to another user is rejected.
		err = store.LinkOIDCIdentity(ctx, bob.ID, testIssuer, testSubject)
		require.ErrorIs(t, err, ErrOIDCIdentityLinked)

		// Provisioning a new user for an already-linked identity is rejected too.
		_, err = store.ProvisionSSOUser(ctx, testIssuer, testSubject, "carol", false)
		require.ErrorIs(t, err, ErrOIDCIdentityLinked)
	})
}

func TestLinkUnlinkOIDCIdentity(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		ctx := t.Context()

		t.Run("link then log in via SSO resolves to the same account", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			alice, err := store.Create(ctx, "alice", "password123")
			require.NoError(t, err)

			require.NoError(t, store.LinkOIDCIdentity(ctx, alice.ID, testIssuer, testSubject))

			found, err := store.GetByOIDCIdentity(ctx, testIssuer, testSubject)
			require.NoError(t, err)
			assert.Equal(t, alice.ID, found.ID)
		})

		t.Run("unlink is blocked for a password-less user, allowed once a password exists", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			// SSO-provisioned: no local password.
			ssoUser, err := store.ProvisionSSOUser(ctx, testIssuer, testSubject, "alice", false)
			require.NoError(t, err)

			err = store.UnlinkOIDCIdentity(ctx, ssoUser.ID)
			require.ErrorIs(t, err, ErrWouldStrandAccount)

			// Set a password, then unlink succeeds and clears the identity.
			require.NoError(t, store.UpdatePassword(ctx, ssoUser.ID, "newpassword1"))
			require.NoError(t, store.UnlinkOIDCIdentity(ctx, ssoUser.ID))

			_, err = store.GetByOIDCIdentity(ctx, testIssuer, testSubject)
			require.ErrorIs(t, err, ErrUserNotFound)
		})

		t.Run("unlink is safe for a user who linked SSO onto a local account", func(t *testing.T) {
			store := newTestUserStore(t, driver)
			alice, err := store.Create(ctx, "alice", "password123")
			require.NoError(t, err)
			require.NoError(t, store.LinkOIDCIdentity(ctx, alice.ID, testIssuer, testSubject))

			require.NoError(t, store.UnlinkOIDCIdentity(ctx, alice.ID))

			// The identity is now free to bind elsewhere.
			bob, err := store.Create(ctx, "bob", "password123")
			require.NoError(t, err)
			require.NoError(t, store.LinkOIDCIdentity(ctx, bob.ID, testIssuer, testSubject))
		})
	})
}
