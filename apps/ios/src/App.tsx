import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { nativeTokens } from '@serein/design-tokens/native';

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.wordmark}>
          Serein
        </Text>
        <Text style={styles.heading}>Calm, exact, and accessible by default.</Text>
        <Text style={styles.body}>
          Every financial value will preserve its status, freshness, and recovery action.
        </Text>
        <View accessibilityLabel="Updated now. Current financial data." style={styles.status}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Updated now</Text>
        </View>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: nativeTokens.light.textMuted,
    fontSize: nativeTokens.typography.body,
    lineHeight: nativeTokens.typography.bodyLineHeight,
  },
  content: {
    gap: nativeTokens.space[6],
    padding: nativeTokens.space[6],
  },
  heading: {
    color: nativeTokens.light.text,
    fontSize: nativeTokens.typography.heading,
    fontWeight: '500',
    letterSpacing: -0.7,
    lineHeight: nativeTokens.typography.headingLineHeight,
  },
  screen: {
    backgroundColor: nativeTokens.light.surface,
    flex: 1,
    justifyContent: 'center',
  },
  status: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: nativeTokens.light.successSurface,
    borderRadius: nativeTokens.radius.pill,
    flexDirection: 'row',
    gap: nativeTokens.space[2],
    minHeight: 44,
    paddingHorizontal: nativeTokens.space[3],
  },
  statusDot: {
    backgroundColor: nativeTokens.light.success,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  statusText: {
    color: nativeTokens.light.success,
    fontSize: 15,
    fontWeight: '600',
  },
  wordmark: {
    color: nativeTokens.light.text,
    fontSize: 23,
  },
});
