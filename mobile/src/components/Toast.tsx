import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { ToastContext, type ToastAction, type ToastType } from '../hooks/useToast';
import { useTheme } from '../theme/ThemeContext';
import { useTranslation } from 'react-i18next';

interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

const TOAST_DURATION_MS = 4000;
const ENTER_ANIMATION_MS = 180;
const EXIT_ANIMATION_MS = 180;

// Fixed colors chosen to read on the dark offlineBanner background in both themes.
const TYPE_CONFIG: Record<ToastType, { color: string; iconName: keyof typeof Ionicons.glyphMap }> = {
  success: { color: '#86efac', iconName: 'checkmark-circle-outline' },
  error:   { color: '#f87171', iconName: 'alert-circle-outline' },
  info:    { color: '#60a5fa', iconName: 'information-circle-outline' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextIdRef = useRef(0);
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };

  const showToast = useCallback((message: string, type: ToastType = 'success', action?: ToastAction) => {
    const id = nextIdRef.current++;
    setToasts((prev) => [...prev, { id, message, type, action }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <View
        pointerEvents="box-none"
        style={[styles.container, { paddingBottom: 24 + insets.bottom }]}
        testID="toast-container"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isExitingRef = useRef(false);
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionInFlightRef = useRef(false);
  const [isActionInFlight, setIsActionInFlight] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  const { color: typeColor, iconName } = TYPE_CONFIG[toast.type];

  const clearAutoDismissTimer = useCallback(() => {
    if (autoDismissTimerRef.current) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
  }, []);

  const close = useCallback((force = false) => {
    if (actionInFlightRef.current && !force) {
      return;
    }
    if (isExitingRef.current) {
      return;
    }
    clearAutoDismissTimer();
    isExitingRef.current = true;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: EXIT_ANIMATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 8,
        duration: EXIT_ANIMATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => onDismiss(toast.id));
  }, [clearAutoDismissTimer, onDismiss, opacity, toast.id, translateY]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: ENTER_ANIMATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: ENTER_ANIMATION_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    autoDismissTimerRef.current = setTimeout(close, TOAST_DURATION_MS);

    return () => {
      clearAutoDismissTimer();
    };
  }, [clearAutoDismissTimer, close, opacity, translateY]);

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          backgroundColor: colors.offlineBanner,
          borderColor: colors.offlineBannerBorder,
          opacity,
          transform: [{ translateY }],
        },
      ]}
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={iconName} size={22} color={typeColor} style={styles.icon} />
      <Text style={[styles.message, { color: colors.offlineBannerText }]} numberOfLines={3}>
        {toast.message}
      </Text>
      {toast.action && (
        <TouchableOpacity
          onPress={async () => {
            if (actionInFlightRef.current) {
              return;
            }
            actionInFlightRef.current = true;
            setIsActionInFlight(true);
            clearAutoDismissTimer();
            try {
              await toast.action?.onPress();
            } catch (error) {
              console.error('Toast action failed:', error);
            } finally {
              close(true);
            }
          }}
          disabled={isActionInFlight}
          style={[styles.actionButton, { backgroundColor: colors.primary }, isActionInFlight && styles.actionButtonDisabled]}
          testID={`toast-action-${toast.id}`}
          accessibilityRole="button"
          accessibilityLabel={toast.action.label}
          accessibilityHint={t('dashboard.toastActionHint', { action: toast.action.label })}
        >
          <Text style={styles.actionText}>{toast.action.label}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => close()} style={styles.closeButton} accessibilityLabel={t('common.close')}>
        <Ionicons name="close" size={18} color={colors.offlineBannerText} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 0,
    zIndex: 100,
    alignItems: 'center',
    gap: 8,
    ...(Platform.OS === 'android' ? { elevation: 10 } : {}),
  },
  toast: {
    width: '100%',
    maxWidth: 560,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  icon: {
    marginRight: 10,
  },
  message: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  actionButton: {
    marginLeft: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  actionButtonDisabled: {
    opacity: 0.6,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  closeButton: {
    marginLeft: 8,
    padding: 8,
  },
});
