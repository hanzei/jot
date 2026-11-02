import { useContext, type ReactNode } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  type DimensionValue,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Space kept below the last row, on top of the bottom safe-area inset. */
const BOTTOM_GAP = 8;

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Rendered as the sheet's heading. Omit when the content draws its own header. */
  title?: string;
  /** Set on the `Modal`; the dismissing backdrop gets `${testID}-backdrop`. */
  testID?: string;
  /** Caps the sheet's height (e.g. `'70%'`) for sheets whose content scrolls. */
  maxHeight?: DimensionValue;
  /**
   * Keep the sheet above the soft keyboard, for sheets with a text input.
   * Android runs edge-to-edge and does not resize the window for the keyboard,
   * so the sheet is lifted by the keyboard height manually; iOS uses
   * KeyboardAvoidingView's "padding" behavior instead (NoteEditorScreen uses
   * the same pattern).
   */
  avoidKeyboard?: boolean;
  children: ReactNode;
}

/**
 * The shared modal bottom sheet: a dimmed backdrop that dismisses on tap, a
 * sheet with rounded top corners, a drag handle, and an optional title. Every
 * sheet uses one bottom-padding rule, `insets.bottom + BOTTOM_GAP`; the only
 * addition is the keyboard lift from `avoidKeyboard`.
 *
 * Insets come from `SafeAreaInsetsContext` (the content insets, see
 * `useDeviceSafeAreaInsets`): a sheet only touches the bottom edge.
 */
export default function BottomSheet({
  visible,
  onClose,
  title,
  testID,
  maxHeight,
  avoidKeyboard = false,
  children,
}: BottomSheetProps) {
  const { colors } = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;

  const backdrop = (
    <Pressable
      style={[styles.overlay, { backgroundColor: colors.overlay }]}
      onPress={onClose}
      testID={testID ? `${testID}-backdrop` : undefined}
    >
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.sheetBackground,
            paddingBottom: insets.bottom + BOTTOM_GAP,
          },
          maxHeight !== undefined && { maxHeight },
        ]}
      >
        {/* Swallows taps on the sheet so only the backdrop dismisses it. */}
        <Pressable style={styles.content}>
          <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
          {title ? <Text style={[styles.title, { color: colors.text }]}>{title}</Text> : null}
          {children}
        </Pressable>
      </View>
      {avoidKeyboard && Platform.OS === 'android' ? <AndroidKeyboardSpacer /> : null}
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} testID={testID}>
      {avoidKeyboard ? (
        <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {backdrop}
        </KeyboardAvoidingView>
      ) : backdrop}
    </Modal>
  );
}

// Its own component so only sheets that opt into `avoidKeyboard` subscribe to
// keyboard events.
function AndroidKeyboardSpacer() {
  const keyboardHeight = useKeyboardHeight();
  return <View style={{ height: keyboardHeight }} />;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  // Lets scrolling content shrink to fit a `maxHeight`-capped sheet.
  content: {
    flexShrink: 1,
  },
  handle: {
    width: 40,
    height: 5,
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
});
