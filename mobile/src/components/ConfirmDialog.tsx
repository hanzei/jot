import React, { useCallback, useContext, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { ConfirmContext, type ConfirmOptions } from '../hooks/useConfirm';

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  // Omit to render a single, non-dismissable confirm action (no cancel button,
  // backdrop tap and hardware back are no-ops) — used for prompts the user
  // must resolve via the primary action.
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  destructive?: boolean;
  // Set while a caller-driven async action (e.g. a retry) is in flight to
  // block both actions and backdrop/back dismissal — callers whose onConfirm
  // / onCancel resolve synchronously (the common useConfirm() case) never
  // need this since the dialog unmounts before any async work starts.
  busy?: boolean;
}

export default function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  destructive,
  busy,
}: ConfirmDialogProps) {
  const { colors } = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const dismiss = busy ? () => {} : onCancel ?? (() => {});

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss}>
      <Pressable
        style={[styles.overlay, { backgroundColor: colors.overlay, paddingBottom: insets.bottom }]}
        onPress={dismiss}
        testID="confirm-dialog-overlay"
      >
        <Pressable
          style={[styles.card, { backgroundColor: colors.cardBackground }]}
          accessibilityRole="alert"
          testID="confirm-dialog"
        >
          {destructive && (
            <View style={[styles.iconCircle, { backgroundColor: colors.errorLight }]}>
              <Ionicons name="warning-outline" size={22} color={colors.error} />
            </View>
          )}
          <Text style={[styles.title, { color: colors.text }]} testID="confirm-dialog-title">
            {title}
          </Text>
          <Text style={[styles.message, { color: colors.textSecondary }]} testID="confirm-dialog-message">
            {message}
          </Text>
          <View style={styles.actions}>
            {onCancel && (
              <TouchableOpacity
                style={[styles.button, styles.cancelButton, { borderColor: colors.border }, busy && styles.buttonDisabled]}
                onPress={onCancel}
                disabled={busy}
                testID="confirm-dialog-cancel"
                accessibilityRole="button"
                accessibilityLabel={cancelLabel}
              >
                <Text style={[styles.cancelText, { color: colors.text }]}>{cancelLabel}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.button, { backgroundColor: destructive ? colors.error : colors.primary }, busy && styles.buttonDisabled]}
              onPress={onConfirm}
              disabled={busy}
              testID="confirm-dialog-confirm"
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
            >
              <Text style={styles.confirmText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface ConfirmRequest {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setRequest({ options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    request?.resolve(true);
    setRequest(null);
  }, [request]);

  const handleCancel = useCallback(() => {
    request?.resolve(false);
    setRequest(null);
  }, [request]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <ConfirmDialog
        visible={!!request}
        title={request?.options.title ?? ''}
        message={request?.options.message ?? ''}
        confirmLabel={request?.options.confirmLabel ?? ''}
        cancelLabel={request?.options.cancelLabel ?? t('common.cancel')}
        destructive={request?.options.destructive}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ConfirmContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    padding: 20,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
  },
  confirmText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
