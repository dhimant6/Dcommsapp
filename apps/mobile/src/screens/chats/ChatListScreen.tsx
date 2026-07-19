import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MainStackParams } from '../../navigation/RootNavigator';
import { ConvRow, listConversations, onChatDbChange } from '../../db/chatRepo';
import { fullSync, startChatSync } from '../../sync/chatSync';

type Props = NativeStackScreenProps<MainStackParams, 'ChatList'>;

/**
 * Sync-rule #1 in action: this list renders FROM SQLITE ONLY, so it is
 * instant and complete with airplane mode on. The network's only job is to
 * write into the DB (startChatSync); the DB-change notifier re-queries.
 */
export function ChatListScreen({ navigation }: Props) {
  const [convs, setConvs] = useState<ConvRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    void listConversations().then(setConvs);
  }, []);

  useEffect(() => {
    startChatSync(); // idempotent: connects WS + kicks the first sync once
    reload();
    return onChatDbChange(reload);
  }, [reload]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fullSync();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <FlatList
      style={styles.list}
      data={convs}
      keyExtractor={(c) => c.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      ListEmptyComponent={<Text style={styles.empty}>No chats yet — start one from the web app, then pull to refresh.</Text>}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() => navigation.navigate('ChatRoom', { conversationId: item.id, title: item.title })}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(item.title || '?').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.preview} numberOfLines={1}>{item.preview}</Text>
          </View>
          {item.unread_count > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.unread_count}</Text>
            </View>
          )}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#fff' },
  empty: { color: '#888', textAlign: 'center', padding: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  meta: { flex: 1 },
  title: { fontSize: 16, fontWeight: '600', color: '#111b21' },
  preview: { fontSize: 13, color: '#667781', marginTop: 2 },
  badge: { backgroundColor: '#3b82f6', borderRadius: 12, minWidth: 24, paddingHorizontal: 7, paddingVertical: 2, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
