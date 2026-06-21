import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { randomUUID } from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import {
  Camera,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Square,
  X,
} from "lucide-react-native";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { getCurrentMemberId } from "@/lib/member";
import { supabase } from "@/lib/supabase";
import { uploadAttachment, type RNFile } from "@/lib/api";

// Paperclip control beside the composer. Message-first: insert the message row
// (client-side RLS, like sendMessage), then upload the attachment onto it.
export function AttachComposer({
  roomId,
  caption,
  onSent,
}: {
  roomId: string;
  caption: string;
  onSent: () => void;
}) {
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const recordingRef = useRef<Audio.Recording | null>(null);

  const upload = useMutation({
    mutationFn: async (file: RNFile): Promise<void> => {
      const memberId = await getCurrentMemberId();
      if (!memberId) {
        throw new Error("Could not resolve your member id.");
      }
      const { data, error } = await supabase
        .from("messages")
        .insert({
          room_id: roomId,
          author_member_id: memberId,
          body: caption.trim().length > 0 ? caption.trim() : null,
          kind: "attachment",
        })
        .select("id")
        .single();
      if (error) {
        throw error;
      }
      await uploadAttachment(roomId, data.id, file);
    },
    onSuccess: () => {
      onSent();
      queryClient.invalidateQueries({ queryKey: ["messages", roomId] });
    },
    onError: (e) => {
      console.error("Attach failed:", e);
    },
  });

  const pickFromLibrary = useCallback(async () => {
    setOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    if (res.canceled || !res.assets?.[0]) {
      return;
    }
    const a = res.assets[0];
    upload.mutate({
      uri: a.uri,
      name: a.fileName ?? `${randomUUID()}.jpg`,
      type: a.mimeType ?? "image/jpeg",
    });
  }, [upload]);

  const takePhoto = useCallback(async () => {
    setOpen(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (res.canceled || !res.assets?.[0]) {
      return;
    }
    const a = res.assets[0];
    upload.mutate({
      uri: a.uri,
      name: a.fileName ?? `${randomUUID()}.jpg`,
      type: a.mimeType ?? "image/jpeg",
    });
  }, [upload]);

  const startRecording = useCallback(async () => {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY,
    );
    recordingRef.current = recording;
    setIsRecording(true);
  }, []);

  const stopRecordingAndSend = useCallback(async () => {
    const recording = recordingRef.current;
    setIsRecording(false);
    if (!recording) {
      return;
    }
    let uri: string | null = null;
    try {
      await recording.stopAndUnloadAsync();
      uri = recording.getURI();
    } catch {
      uri = null;
    }
    recordingRef.current = null;
    setOpen(false);
    if (!uri) {
      return;
    }
    upload.mutate({ uri, name: `${randomUUID()}.m4a`, type: "audio/m4a" });
  }, [upload]);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={upload.isPending}
        style={styles.attachBtn}
        hitSlop={8}
        testID="attach-button"
      >
        {upload.isPending ? (
          <ActivityIndicator size="small" color={Theme.primary} />
        ) : (
          <Paperclip color={Theme.primary} size={22} />
        )}
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.sheet, { paddingTop: insets.top + 12 }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Add attachment</Text>
            <Pressable
              onPress={() => {
                if (isRecording) {
                  stopRecordingAndSend();
                } else {
                  setOpen(false);
                }
              }}
              hitSlop={12}
            >
              <X color={Theme.textMuted} size={24} />
            </Pressable>
          </View>

          {!isRecording ? (
            <>
              <Pressable style={styles.option} onPress={pickFromLibrary}>
                <ImageIcon color={Theme.primary} size={22} />
                <Text style={styles.optionText}>Photo library</Text>
              </Pressable>
              <Pressable style={styles.option} onPress={takePhoto}>
                <Camera color={Theme.primary} size={22} />
                <Text style={styles.optionText}>Take photo</Text>
              </Pressable>
              <Pressable style={styles.option} onPress={startRecording}>
                <Mic color={Theme.primary} size={22} />
                <Text style={styles.optionText}>Record audio</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={[styles.option, styles.recording]}
              onPress={stopRecordingAndSend}
            >
              <Square color="#FFFFFF" size={22} fill="#FFFFFF" />
              <Text style={[styles.optionText, styles.recordingText]}>
                Stop &amp; send
              </Text>
            </Pressable>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  attachBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.surface,
    marginRight: 6,
  },
  sheet: { flex: 1, backgroundColor: Theme.background, paddingHorizontal: 20 },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: Theme.text },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: Theme.surface,
    marginBottom: 12,
  },
  optionText: { fontSize: 16, color: Theme.text, fontWeight: "600" },
  recording: { backgroundColor: Theme.coral },
  recordingText: { color: "#FFFFFF" },
});
