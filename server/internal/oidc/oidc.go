// Package oidc wraps the OpenID Connect authorization-code + PKCE flow Jot
// uses for SSO login. It performs provider discovery and JWKS-backed ID-token
// verification (via coreos/go-oidc) on top of golang.org/x/oauth2, exposing
// just the two operations the handlers need: build an authorization-request URL
// and verify a callback's code into a resolved identity.
//
// It is constructed once at server startup when OIDC is configured; a discovery
// or JWKS failure there is a startup error, not a per-request surprise.
package oidc

import (
	"context"
	"errors"
	"fmt"

	coreoidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Config holds the settings needed to construct a Provider. It mirrors the
// validated JOT_OIDC_* configuration.
type Config struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
}

// Provider is a configured OIDC relying-party client: an oauth2 config for the
// authorization-code exchange plus an ID-token verifier bound to the provider's
// JWKS.
type Provider struct {
	oauth2Config *oauth2.Config
	verifier     *coreoidc.IDTokenVerifier
}

// Identity is the verified result of a successful callback: the stable
// (Issuer, Subject) match key, the Nonce the ID token carried (for the caller
// to compare against the one it issued), and the raw claim set for seeding a
// username.
type Identity struct {
	Issuer  string
	Subject string
	Nonce   string
	Claims  map[string]any
}

// NewProvider performs OIDC discovery against cfg.Issuer (fetching the
// discovery document and preparing the JWKS-backed verifier) and returns a
// ready Provider. A discovery or network failure is returned as an error so the
// caller can fail startup.
func NewProvider(ctx context.Context, cfg Config) (*Provider, error) {
	provider, err := coreoidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery for %q: %w", cfg.Issuer, err)
	}

	return &Provider{
		oauth2Config: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  cfg.RedirectURL,
			Scopes:       cfg.Scopes,
		},
		verifier: provider.Verifier(&coreoidc.Config{ClientID: cfg.ClientID}),
	}, nil
}

// AuthCodeURL builds the authorization-request URL to redirect the browser to.
// state is the CSRF token echoed back on the callback, nonce is bound into the
// ID token, and verifier is the PKCE code verifier whose S256 challenge is sent
// now (the verifier itself is presented later at Verify).
func (p *Provider) AuthCodeURL(state, nonce, verifier string) string {
	return p.oauth2Config.AuthCodeURL(state,
		coreoidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	)
}

// Verify exchanges an authorization code (presenting the PKCE verifier) for
// tokens at the token endpoint, then verifies the returned ID token's
// signature, issuer, audience, and expiry against the provider JWKS. It returns
// the resolved Identity; the caller must still compare Identity.Nonce against
// the nonce it issued.
func (p *Provider) Verify(ctx context.Context, code, verifier string) (*Identity, error) {
	token, err := p.oauth2Config.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, fmt.Errorf("exchange authorization code: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return nil, errors.New("token response did not include an id_token")
	}

	idToken, err := p.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("verify id token: %w", err)
	}

	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("parse id token claims: %w", err)
	}

	return &Identity{
		Issuer:  idToken.Issuer,
		Subject: idToken.Subject,
		Nonce:   idToken.Nonce,
		Claims:  claims,
	}, nil
}
