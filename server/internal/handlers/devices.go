package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type DevicesHandler struct {
	deviceTokenStore *models.DeviceTokenStore
}

func NewDevicesHandler(deviceTokenStore *models.DeviceTokenStore) *DevicesHandler {
	return &DevicesHandler{deviceTokenStore: deviceTokenStore}
}

type RegisterDeviceRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

// RegisterDevice handles POST /api/v1/devices.
// It registers a device push notification token for the authenticated user.
func (h *DevicesHandler) RegisterDevice(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req RegisterDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Token == "" {
		return http.StatusBadRequest, errors.New("token is required")
	}

	if req.Platform == "" {
		req.Platform = "android"
	}

	dt, err := h.deviceTokenStore.Register(user.ID, req.Token, req.Platform)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(dt); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

// UnregisterDevice handles DELETE /api/v1/devices/{token}.
// It unregisters a device push notification token for the authenticated user.
func (h *DevicesHandler) UnregisterDevice(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	token := chi.URLParam(r, "token")
	if token == "" {
		return http.StatusBadRequest, errors.New("token is required")
	}

	err := h.deviceTokenStore.Delete(user.ID, token)
	if err != nil {
		if errors.Is(err, models.ErrDeviceTokenNotFound) {
			return http.StatusNotFound, errors.New("device token not found")
		}
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}
