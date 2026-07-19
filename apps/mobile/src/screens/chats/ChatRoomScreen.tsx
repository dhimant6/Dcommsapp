import { useCallback, useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParams } from '../../navigation/RootNavigator';
import { MsgRow, clearUnread, listMessages, onChatDbChange, unreadServerIds } from '../../db/chatRepo';
import { useAuthStore } from '../../state/authStore';
import { sendChatMessage } from '../../sync/chatSync';
import { socket } from '../../ws/socket';

type Props = NativeStackScreenProps<MainStackParams, 'ChatRoom'>;

/**
 * The optimistic-send loop, end to end:
 *  send → SQLite 'pending' row (🕐 immediately, no network on the render path)
 *  → WS chat_message → send_ack flips to ✓ → delivery/read acks → ✓✓ / blue ✓✓.
 * The inverted FlatList reads newest-first straight from the repo query.
 */
export function ChatRoomScreen({ route }: Props) {
  const { conversationId } = route.params;
  const me = useAuthStore((s) => s.userId);
  const [msgs, setMsgs] = useState<MsgRow[]>([]);
  const [text, setText] = useState('');

  const reload = useCallback(() => {
    void listMessages(conversationId).then(setMsgs);
  }, [conversationId]);

  useEffect(() => {
    reload();
    return onChatDbChange(reload);
  }, [reload]);

  // Opening the chat is the "human saw it" moment: batch read_ack everything
  // received here, and zero the local unread badge. Re-acking already-read
  // ids on later renders is harmless — the server watermark is idempotent.
  useEffect(() => {
    void unreadServerIds(conversationId, me!).then((ids) => {
      if (ids.length) socket.send({ type: 'read_ack', payload: { conversationId, messageIds: ids } });
    });
    void clearUnread(conversationId);
  }, [conversationId, me, msgs.length]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    sendChatMessage(conversationId, body);
    setText('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        style={styles.list}
        inverted
        data={msgs}
        keyExtractor={(m) => m.client_msg_id}
        renderItem={({ item }) => <Bubble m={item} own={item.sender_id === me} />}
      />
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Type a message"
          multiline
        />
        <Pressable style={[styles.sendBtn, !text.trim() && styles.sendBtnOff]} onPress={send} disabled={!text.trim()}>
          <Text style={styles.sendText}>➤</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const TICKS: Record<MsgRow['status'], string> = { pending: '🕐', sent: '✓', delivered: '✓✓', read: '✓✓' };

function Bubble({ m, own }: { m: MsgRow; own: boolean }) {
  let body = '';
  try {
    const c = JSON.parse(m.content);
    body = c.body ?? (c.url ? `[${m.type}]` : '');
  } catch {
    body = m.content;
  }
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <View style={[styles.bubble, own ? styles.own : styles.theirs]}>
      <Text style={styles.body}>{body}</Text>
      <Text style={[styles.stamp, own && m.status === 'read' && styles.read]}>
        {time} {own ? TICKS[m.status] : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#efeae2' },
  list: { flex: 1, paddingHorizontal: 10 },
  bubble: { maxWidth: '82%', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginVertical: 2 },
  own: { alignSelf: 'flex-end', backgroundColor: '#d9fdd3' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#fff' },
  body: { fontSize: 15, color: '#111b21' },
  stamp: { fontSize: 10, color: '#667781', alignSelf: 'flex-end', marginTop: 2 },
  read: { color: '#53bdeb' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, backgroundColor: '#f0f2f5' },
  input: { flex: 1, backgroundColor: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15, maxHeight: 110 },
  sendBtn: { backgroundColor: '#128c7e', borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { opacity: 0.5 },
  sendText: { color: '#fff', fontSize: 18 },
});
