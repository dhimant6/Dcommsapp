import { View, Text, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParams } from '../../navigation/RootNavigator';

type Props = NativeStackScreenProps<MainStackParams, 'ChatRoom'>;

/**
 * PLACEHOLDER â€” deepened in the "Client Chat UI" module.
 *
 * Contract when implemented (the optimistic-send loop):
 * 1. User hits send â†’ INSERT into SQLite with status='pending' + clientMsgId â†’ UI
 *    shows the bubble immediately (ðŸ•).
 * 2. WS frame chat_message goes out. On send_ack â†’ status='sent' (âœ“).
 * 3. delivery_ack / read_ack events â†’ âœ“âœ“ / blue âœ“âœ“.
 * 4. On reconnect, any rows still 'pending' are re-sent â€” clientMsgId makes
 *    retries idempotent server-side.
 * 5. Inverted FlatList reading pages from SQLite; scroll-up triggers REST
 *    history fetch for older pages.
 */
export function ChatRoomScreen({ route }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.hint}>
        Conversation {route.params.conversationId} â€” implemented in the Client Chat UI module.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hint: { color: '#888', textAlign: 'center' },
});

