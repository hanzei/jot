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
import { ZERO_INSETS } from './ContentSafeArea';

/** Space kept below the last row, on top of the bottom safe-area inset. */
const BOTTOM_GAP = 8;

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Rendered as the sheet's heading. Omit when the content draws its own header. */
  title?: string;
  /** Set on the `Modal`; the backdrop gets `${testID}-backdrop` and the sheet `${testID}-sheet`. */
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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} testID={testID}>
      {/* With `enabled={false}` this is a plain View. */}
      <KeyboardAvoidingView
        style={styles.overlay}
        enabled={avoidKeyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={[styles.overlay, { backgroundColor: colors.overlay }]}
          onPress={onClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        >
          {/* A Pressable without onPress swallows every tap on the sheet,
              padding included, so only the backdrop dismisses it. */}
          <Pressable
            testID={testID ? `${testID}-sheet` : undefined}
            style={[
              styles.sheet,
              {
                backgroundColor: colors.sheetBackground,
                paddingBottom: insets.bottom + BOTTOM_GAP,
                maxHeight,
              },
            ]}
          >
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            {title ? <Text style={[styles.title, { color: colors.text }]}>{title}</Text> : null}
            {children}
          </Pressable>
          {avoidKeyboard && Platform.OS === 'android' ? <AndroidKeyboardSpacer /> : null}
        </Pressable>
      </KeyboardAvoidingView>
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
