jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@expo/vector-icons/Ionicons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const MockIonicons = React.forwardRef(function MockIonicons(props, ref) {
    return React.createElement(Text, { ...props, ref, testID: props.testID || `icon-${props.name}` }, props.name);
  });
  MockIonicons.glyphMap = {};
  return { __esModule: true, default: MockIonicons };
});
