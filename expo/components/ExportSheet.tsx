// expo/components/ExportSheet.tsx ??pick region/size/branding, export an approved
// note to a verifiable PDF, and open it (share/save/print via the OS browser sheet).
import React, { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import * as Linking from "expo-linking";
import { X, FileDown, Check } from "lucide-react-native";
import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { fetchBrandingOptions, type BrandingOption } from "@/lib/branding";

type Props = { artifactId: string; visible: boolean; onClose: () => void };

const STYLES: { key: string; label: string }[] = [
  { key: "hk_uk", label: "Hong Kong / UK" },
  { key: "us", label: "United States" },
  { key: "cn", label: "Mainland China" },
];
const SIZES: { key: string; label: string }[] = [
  { key: "standard", label: "Standard" },
  { key: "large_print", label: "Large print" },
];

export default function ExportSheet({ artifactId, visible, onClose }: Props) {
  const [style, setStyle] = useState("hk_uk");
  const [size, setSize] = useState("standard");
  const [brand, setBrand] = useState<string | null>(null); // profile_id | null
  const [brands, setBrands] = useState<BrandingOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setErr(null);
    fetchBrandingOptions().then((b) => {
      setBrands(b);
      const def = b.find((x) => x.is_org_default);
      setBrand(def ? def.id : null);
    });
  }, [visible]);

  const doExport = async () => {
    setBusy(true); setErr(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("No active session.");
      const body: Record<string, unknown> = { style, size };
      if (brand) body.profile_id = brand;
      const res = await fetch(
        `${process.env.EXPO_PUBLIC_BACKEND_URL}/note/${artifactId}/export-pdf`,
        { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body) });
      if (!res.ok) {
        if (res.status === 409) throw new Error("Only approved notes can be exported.");
        if (res.status === 403) throw new Error("You don't have access to export this note.");
        throw new Error("Export failed. Please try again.");
      }
      const out = await res.json();
      onClose();
      if (out?.url) await Linking.openURL(out.url);
    } catch (e: any) {
      setErr(e?.message ?? "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Export as PDF</Text>
            <Pressable onPress={onClose} hitSlop={10}><X size={22} color={Theme.textMuted} /></Pressable>
          </View>
          <ScrollView style={{ maxHeight: 420 }}>
            <Text style={styles.group}>Document style</Text>
            {STYLES.map((s) => (
              <Row key={s.key} label={s.label} active={style === s.key} onPress={() => setStyle(s.key)} />
            ))}
            <Text style={styles.group}>Size</Text>
            {SIZES.map((s) => (
              <Row key={s.key} label={s.label} active={size === s.key} onPress={() => setSize(s.key)} />
            ))}
            <Text style={styles.group}>Branding</Text>
            {brands.map((b) => (
              <Row key={b.id ?? "nanohab"} label={brandLabel(b)} active={brand === b.id}
                   onPress={() => setBrand(b.id)} />
            ))}
          </ScrollView>
          {err ? <Text style={styles.err}>{err}</Text> : null}
          <Pressable style={[styles.exportBtn, busy && styles.exportBtnBusy]} onPress={doExport} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : (
              <View style={styles.exportInner}>
                <FileDown size={18} color="#fff" />
                <Text style={styles.exportText}>Export PDF</Text>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function brandLabel(b: BrandingOption): string {
  if (b.id === null) return b.display_name;
  const tier = b.branding_tier === "whitelabel" ? "White-label" : "Co-brand";
  return `${b.display_name} (${tier})${b.is_org_default ? "  \u00b7  default" : ""}`;
}

function Row({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.row, active && styles.rowActive]} onPress={onPress}>
      <Text style={[styles.rowText, active && styles.rowTextActive]}>{label}</Text>
      {active ? <Check size={18} color={Theme.primary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 30 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  title: { fontSize: 18, fontWeight: "800", color: Theme.text },
  group: { fontSize: 12, fontWeight: "700", color: Theme.textMuted, marginTop: 14, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "#F4F7F6", marginBottom: 6 },
  rowActive: { backgroundColor: "#E6F1ED", borderWidth: 1, borderColor: Theme.primary },
  rowText: { fontSize: 15, color: Theme.text },
  rowTextActive: { fontWeight: "700", color: Theme.primary },
  err: { color: "#B42318", fontSize: 13, marginTop: 10 },
  exportBtn: { marginTop: 16, backgroundColor: Theme.primary, borderRadius: 12, paddingVertical: 15, alignItems: "center" },
  exportBtnBusy: { opacity: 0.7 },
  exportInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  exportText: { color: "#fff", fontSize: 16, fontWeight: "800" },
});
