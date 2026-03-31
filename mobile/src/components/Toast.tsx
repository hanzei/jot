import React, { useCallback, useEffect, useRef, useState } from 'react';
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
const EXIT_ANIMATION_MS = 180;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextIdRef = useRef(0);

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
      <SafeAreaInsetsContext.Consumer>
        {(insets) => (
          <View
            pointerEvents="box-none"
            style={[styles.container, { paddingBottom: 12 + (insets?.bottom ?? 0) }]}
            testID="toast-container"
          >
            {toasts.map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
            ))}
          </View>
        )}
      </SafeAreaInsetsContext.Consumer>
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
  const typeColor = toast.type === 'success'
    ? colors.success
    : toast.type === 'error'
      ? colors.error
      : colors.primary;
  const iconName: keyof typeof Ionicons.glyphMap = toast.type === 'success'
    ? 'checkmark-circle-outline'
    : toast.type === 'error'
      ? 'alert-circle-outline'
      : 'information-circle-outline';

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
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 180,
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
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity,
          transform: [{ translateY }],
        },
      ]}
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={iconName} size={20} color={typeColor} style={styles.icon} />
      <Text style={[styles.message, { color: colors.text }]} numberOfLines={3}>
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
          style={styles.actionButton}
          testID={`toast-action-${toast.id}`}
        >
          <Text style={[styles.actionText, { color: colors.primary }]}>{toast.action.label}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => close()} style={styles.closeButton} accessibilityLabel={t('common.close')}>
        <Ionicons name="close" size={16} color={colors.textMuted} />
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
    paddingBottom: 12,
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
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  icon: {
    marginRight: 8,
  },
  message: {
    flex: 1,
    fontSize: 14,
    lineHeight: 18,
  },
  actionButton: {
    marginLeft: 10,
    paddingVertical: 2,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  closeButton: {
    marginLeft: 4,
    padding: 4,
  },
});
