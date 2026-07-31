import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useAnimatedValue,
  View,
} from 'react-native';
import { CircleAlert, CircleCheck, Info, X, type LucideIcon } from 'lucide-react-native';
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

// Exported so callers that need a server write to stay in sync with the
// visible undo window (e.g. the note-image deferred-delete timer) don't drift
// out of step with the toast's own auto-dismiss.
export const TOAST_DURATION_MS = 4000;
const ENTER_ANIMATION_MS = 180;
const EXIT_ANIMATION_MS = 180;

// Fixed colors chosen to read on the dark offlineBanner background in both themes.
const TYPE_CONFIG: Record<ToastType, { color: string; icon: LucideIcon }> = {
  success: { color: '#86efac', icon: CircleCheck },
  error:   { color: '#f87171', icon: CircleAlert },
  info:    { color: '#60a5fa', icon: Info },
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
  const opacity = useAnimatedValue(0);
  const translateY = useAnimatedValue(12);
  const { color: typeColor, icon: Icon } = TYPE_CONFIG[toast.type];

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
    // actionInFlightRef is only true here when this close() came from the
    // action handler's post-onPress `close(true)` — every other path (the
    // auto-dismiss timer, the X button) reaches here with it false, which is
    // exactly "dismissed without the action running."
    if (!actionInFlightRef.current) {
      toast.action?.onExpire?.();
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
  }, [clearAutoDismissTimer, onDismiss, opacity, toast.action, toast.id, translateY]);

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
      <Icon size={22} color={typeColor} style={styles.icon} />
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
      <TouchableOpacity
        onPress={() => close()}
        style={styles.closeButton}
        accessibilityLabel={t('common.close')}
        testID={`toast-close-${toast.id}`}
      >
        <X size={18} color={colors.offlineBannerText} />
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
