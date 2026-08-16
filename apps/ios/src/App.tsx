import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.wordmark}>
          Serein
        </Text>
        <Text style={styles.heading}>Your financial workspace is being prepared.</Text>
        <Text style={styles.body}>
          This private view will show your authoritative daily allowance when setup is complete.
        </Text>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: '#41564a',
    fontSize: 17,
    lineHeight: 25,
  },
  content: {
    gap: 20,
    padding: 24,
  },
  heading: {
    color: '#15231d',
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.7,
    lineHeight: 42,
  },
  screen: {
    backgroundColor: '#f5f3ec',
    flex: 1,
    justifyContent: 'center',
  },
  wordmark: {
    color: '#15231d',
    fontFamily: 'Georgia',
    fontSize: 23,
  },
});
