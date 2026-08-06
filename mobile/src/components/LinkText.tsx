import { memo } from 'react';
import { Text, StyleSheet, type TextStyle, type StyleProp } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { openUrl } from '../utils/openUrl';

const URL_SPLIT_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;
const URL_TEST_REGEX = /^https?:\/\//i;

interface LinkTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
}

function LinkText({ text, style }: LinkTextProps) {
  const { colors } = useTheme();
  const parts = text.split(URL_SPLIT_REGEX);

  return (
    <Text style={style}>
      {parts.map((part, i) => {
        if (!URL_TEST_REGEX.test(part)) {
          return <Text key={i}>{part}</Text>;
        }
        const m = part.match(/^(https?:\/\/\S+?)([).,!?:;]+)?$/i);
        let url = m?.[1] ?? part;
        let trailing = m?.[2] ?? '';
        // Reabsorb ')' that close an unmatched '(' in the URL so that
        // URLs with balanced parentheses (e.g. Wikipedia) are not broken.
        let open = (url.match(/\(/g)?.length ?? 0) - (url.match(/\)/g)?.length ?? 0);
        while (open > 0 && trailing.startsWith(')')) {
          url += ')';
          trailing = trailing.slice(1);
          open--;
        }
        return (
          <Text key={i}>
            <Text
              style={[styles.link, { color: colors.primary }]}
              onPress={() => void openUrl(url)}
              suppressHighlighting
            >
              {url}
            </Text>
            {trailing}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    textDecorationLine: 'underline',
  },
});

export default memo(LinkText);
