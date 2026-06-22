// expo/components/WetSignSheet.tsx — attach a wet-ink-signed PAPER scan to an
// approved, exported note, pairing it to a chosen issued document (doc_id).
// Reuses the proven multipart-upload pattern (logo picker) + Modal/Pressable backdrop.
import React, { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { X, FileUp, Check } from "lucide-react-native";
import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

type IssuedDoc = { doc_id: string; issued_at: string; branding_tier: string | null };
type Props = { artifactId: string; visible: boolean; onClose: () => void };

export default function WetSignSheet({ artifactId, visible, onClose }: Props) {
  const [docs, setDocs] = useState<IssuedDoc[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setErr(null); setDone(false); setPicked(null);
    // list issued documents via the membership-gated backend (issued_documents is
    // service-role only; the app cannot query it directly).
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const r = await fetch(`${process.env.EXPO_PUBLIC_BACKEND_URL}/note/${artifactId}/issued-documents`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { setErr("Could not load this note's documents."); return; }
        const j = await r.json();
        const list = (j.documents ?? []) as IssuedDoc[];
        setDocs(list);
        if (list.length === 1) setPicked(list[0].doc_id);
      } catch (e: any) {
        setErr(e?.message ?? "Could not load documents.");
      }
    })();
  }, [visible, artifactId]);

  const upload = async () => {
    if (!picked) { setErr("Choose which document this paper copy is for."); return; }
    setErr(null);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setErr("Photo access is needed to attach a scan."); return; }
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      setBusy(true);
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("No active session.");
      const form = new FormData();
      form.append("doc_id", picked);
      form.append("file", { uri: asset.uri, name: asset.fileName ?? "scan.png", type: asset.mimeType ?? "image/png" } as any);
      const up = await fetch(`${process.env.EXPO_PUBLIC_BACKEND_URL}/note/${artifactId}/wet-sign`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      if (!up.ok) {
        if (up.status === 415) throw new Error("Scan must be a PNG, JPG, or PDF.");
        if (up.status === 413) throw new Error("Scan must be 10 MB or smaller.");
        if (up.status === 400) throw new Error("That document ID doesn't match this note.");
        if (up.status === 403) throw new Error("You can't attach a scan to this note.");
        throw new Error("Upload failed. Please try again.");
      }
      setDone(true);
    } catch (e: any) {
      setErr(e?.message ?? "Could not upload the scan.");
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Attach signed paper copy</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={22} color={Theme.textMuted} /></Pressable>
          </View>
          {done ? (
            <View style={styles.doneBox}>
              <Check size={28} color={Theme.primary} />
              <Text style={styles.doneText}>Paper copy attached and recorded.</Text>
            </View>
          ) : (
            <>
              <Text style={styles.help}>
                Pick the document this signed paper copy corresponds to (read the Document ID
                printed on the page), then choose the scan or photo.
              </Text>
              <ScrollView style={{ maxHeight: 220 }}>
                {docs.length === 0 ? (
                  <Text style={styles.muted}>No exported documents yet. Export this note first, then attach the signed copy.</Text>
                ) : docs.map((d) => (
                  <Pressable key={d.doc_id} style={[styles.row, picked === d.doc_id && styles.rowActive]} onPress={() => setPicked(d.doc_id)}>
                    <Text style={[styles.rowText, picked === d.doc_id && styles.rowTextActive]}>{d.doc_id}</Text>
                    {picked === d.doc_id ? <Check size={18} color={Theme.primary} /> : null}
                  </Pressable>
                ))}
              </ScrollView>
              {err ? <Text style={styles.err}>{err}</Text> : null}
              <Pressable style={[styles.uploadBtn, busy && styles.uploadBusy]} onPress={upload} disabled={busy || docs.length === 0}>
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <View style={styles.uploadInner}><FileUp size={18} color="#fff" /><Text style={styles.uploadText}>Choose scan & upload</Text></View>
                )}
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 30 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  title: { fontSize: 18, fontWeight: "800", color: Theme.text },
  help: { fontSize: 13.5, color: Theme.textMuted, lineHeight: 19, marginBottom: 10 },
  muted: { color: Theme.textMuted, fontSize: 14, paddingVertical: 12 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "#F4F7F6", marginBottom: 6 },
  rowActive: { backgroundColor: "#E6F1ED", borderWidth: 1, borderColor: Theme.primary },
  rowText: { fontSize: 14, color: Theme.text, fontFamily: "Menlo" },
  rowTextActive: { fontWeight: "700", color: Theme.primary },
  err: { color: "#B42318", fontSize: 13, marginTop: 8 },
  uploadBtn: { marginTop: 14, backgroundColor: Theme.primary, borderRadius: 12, paddingVertical: 15, alignItems: "center" },
  uploadBusy: { opacity: 0.7 },
  uploadInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  uploadText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  doneBox: { alignItems: "center", gap: 10, paddingVertical: 24 },
  doneText: { fontSize: 15, fontWeight: "600", color: Theme.text },
});
