import { View, Text, StyleSheet } from 'react-native';

/**
 * PLACEHOLDER â€” deepened in the "Client Chat UI" module.
 *
 * Contract when implemented:
 * - Renders FROM SQLITE ONLY (offline-first: the list is instant with no network).
 * - A sync effect calls GET /conversations, upserts into SQLite; the list
 *   re-renders reactively from the DB â€” network updates the DB, DB updates the UI.
 * - Subscribes to the WS store for live reordering when a new message lands.
 */
export function ChatListScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.hint}>Chat list â€” implemented in the Client Chat UI module.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hint: { color: '#888', textAlign: 'center' },
});

