import React, { memo } from 'react';
import { Text, Linking, StyleSheet, type TextStyle, type StyleProp } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

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
      {parts.map((part, i) =>
        URL_TEST_REGEX.test(part) ? (
          <Text
            key={i}
            style={[styles.link, { color: colors.primary }]}
            onPress={() => Linking.openURL(part)}
            suppressHighlighting
          >
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        )
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    textDecorationLine: 'underline',
  },
});

export default memo(LinkText);
