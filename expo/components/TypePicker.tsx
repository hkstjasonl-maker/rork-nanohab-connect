// expo/components/TypePicker.tsx
// Note-type chooser for typed clinical notes. Defaults to the signed-in member's
// discipline, with "All types" one tap away; pins Free-form as a fallback; offers a
// single auto-detect SUGGESTION the clinician confirms (never auto-applies); and a
// search box that matches on template CODE (ST, ST-02) and name. Reads the registry
// straight from Supabase.
import React, { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  Platform,
  SectionList,
  ActivityIndicator,
  KeyboardAvoidingView,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import {
  listTemplates,
  getMyDiscipline,
  suggestTemplateKey,
  DISCIPLINE_LABEL,
  type DocumentTemplate,
  type Discipline,
} from "@/lib/typedNotes";

const C = {
  primary: "#0F6E56",
  coral: "#F08A6E",
  blue: "#2E7DA6",
  text: "#1A1F1D",
  textMuted: "#5C6661",
  surface: "#F4F6F5",
  border: "#E2E6E4",
  bg: "#FFFFFF",
};

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const DISCIPLINE_ORDER: Discipline[] = [
  "allied_health",
  "medical",
  "nursing",
  "universal",
];

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (templateKey: string, tmpl: DocumentTemplate) => void;
  suggestText?: string; // dictated/typed text, for the confirm-only suggestion
};

export default function TypePicker({ visible, onClose, onPick, suggestText }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const insets = useSafeAreaInsets();

  const templatesQ = useQuery({
    queryKey: ["doc-templates"],
    queryFn: listTemplates,
    staleTime: 1000 * 60 * 30,
  });
  const disciplineQ = useQuery({
    queryKey: ["my-discipline"],
    queryFn: getMyDiscipline,
    staleTime: 1000 * 60 * 30,
  });

  const templates = templatesQ.data ?? [];
  const myDiscipline = disciplineQ.data ?? null;

  const byKey = useMemo(
    () => Object.fromEntries(templates.map((t) => [t.template_key, t])),
    [templates]
  );

  const suggestedKey = useMemo(
    () => (suggestText ? suggestTemplateKey(suggestText, templates) : null),
    [suggestText, templates]
  );
  const suggested = suggestedKey ? byKey[suggestedKey] : null;

  // When the search box has text, this overrides the grouped view with a flat,
  // ranked list: exact code > code prefix > name-word prefix > name contains.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const scored = templates
      .map((t) => {
        const code = (t.code ?? "").toLowerCase();
        const name = t.display_name.toLowerCase();
        let score = -1;
        if (code === q) score = 0;
        else if (code.startsWith(q)) score = 1;
        else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
        else if (name.includes(q)) score = 3;
        else if (code.includes(q)) score = 4;
        return { t, score };
      })
      .filter((r) => r.score >= 0)
      .sort(
        (a, b) =>
          a.score - b.score || (a.t.code ?? "").localeCompare(b.t.code ?? "")
      );
    return scored.map((r) => r.t);
  }, [query, templates]);

  const sections = useMemo(() => {
    const freeform = byKey["freeform"];
    const groups: { title: string; data: DocumentTemplate[] }[] = [];

    if (!showAll && myDiscipline) {
      const mine = templates.filter((t) => t.discipline === myDiscipline);
      const shared = templates.filter(
        (t) => t.discipline === "universal" && t.template_key !== "freeform"
      );
      if (mine.length) groups.push({ title: DISCIPLINE_LABEL[myDiscipline], data: mine });
      if (shared.length) groups.push({ title: DISCIPLINE_LABEL.universal, data: shared });
    } else {
      for (const d of DISCIPLINE_ORDER) {
        const data = templates.filter(
          (t) => t.discipline === d && t.template_key !== "freeform"
        );
        if (data.length) groups.push({ title: DISCIPLINE_LABEL[d], data });
      }
    }
    if (freeform) groups.push({ title: "General", data: [freeform] });
    return groups;
  }, [templates, byKey, showAll, myDiscipline]);

  // While searching, present results as a single section so we reuse one renderItem.
  const displaySections = useMemo(() => {
    if (searchResults) {
      return searchResults.length
        ? [{ title: `${searchResults.length} match${searchResults.length === 1 ? "" : "es"}`, data: searchResults }]
        : [];
    }
    return sections;
  }, [searchResults, sections]);

  const pick = (t: DocumentTemplate) => {
    onPick(t.template_key, t);
    setQuery("");
    onClose();
  };

  const renderRow = (item: DocumentTemplate) => (
    <Pressable style={styles.row} onPress={() => pick(item)}>
      {item.code ? (
        <View style={styles.codeBadge}>
          <Text style={styles.codeBadgeText}>{item.code}</Text>
        </View>
      ) : null}
      <Text style={styles.rowName}>{item.display_name}</Text>
      {item.risk_tier === "extract_flag" && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>values</Text>
        </View>
      )}
    </Pressable>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kav}
        >
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Choose note type</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.close}>Close</Text>
            </Pressable>
          </View>

          {templatesQ.isLoading ? (
            <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
          ) : (
            <>
              {/* search box */}
              <View style={styles.searchWrap}>
                <TextInput
                  style={styles.search}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search name or code (e.g. ST-02)"
                  placeholderTextColor={C.textMuted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {query.length > 0 && (
                  <Pressable onPress={() => setQuery("")} hitSlop={10} style={styles.searchClear}>
                    <Text style={styles.searchClearText}>✕</Text>
                  </Pressable>
                )}
              </View>

              {/* suggestion + toggle only when NOT searching */}
              {!searchResults && suggested && (
                <Pressable style={styles.suggest} onPress={() => pick(suggested)}>
                  <Text style={styles.suggestLabel}>Suggested</Text>
                  <Text style={styles.suggestName}>{suggested.display_name}</Text>
                  <Text style={styles.suggestHint}>Tap to use — or choose below</Text>
                </Pressable>
              )}

              {!searchResults && (
                <View style={styles.toggleRow}>
                  <Pressable
                    onPress={() => setShowAll(false)}
                    style={[styles.toggle, !showAll && styles.toggleOn]}
                  >
                    <Text style={[styles.toggleText, !showAll && styles.toggleTextOn]}>
                      {myDiscipline ? DISCIPLINE_LABEL[myDiscipline] : "My types"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setShowAll(true)}
                    style={[styles.toggle, showAll && styles.toggleOn]}
                  >
                    <Text style={[styles.toggleText, showAll && styles.toggleTextOn]}>
                      All types
                    </Text>
                  </Pressable>
                </View>
              )}

              <SectionList
                sections={displaySections}
                keyExtractor={(item) => item.template_key}
                stickySectionHeadersEnabled={false}
                keyboardShouldPersistTaps="handled"
                renderSectionHeader={({ section }) => (
                  <Text style={styles.sectionHeader}>{section.title}</Text>
                )}
                renderItem={({ item }) => renderRow(item)}
                ListEmptyComponent={
                  searchResults ? (
                    <Text style={styles.emptySearch}>No template matches “{query}”.</Text>
                  ) : null
                }
                ListFooterComponent={<View style={{ height: 24 }} />}
              />
            </>
          )}
        </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  kav: { width: "100%" },
  sheet: {
    backgroundColor: C.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "85%",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 18, fontWeight: "700", color: C.text },
  close: { fontSize: 15, color: C.primary, fontWeight: "600" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    marginTop: 12,
  },
  search: { flex: 1, paddingVertical: 10, fontSize: 15, color: C.text },
  searchClear: { paddingLeft: 8 },
  searchClearText: { fontSize: 15, color: C.textMuted, fontWeight: "700" },
  suggest: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.primary,
  },
  suggestLabel: { fontSize: 11, color: C.primary, fontWeight: "700", letterSpacing: 0.5 },
  suggestName: { fontSize: 16, color: C.text, fontWeight: "600", marginTop: 2 },
  suggestHint: { fontSize: 12, color: C.textMuted, marginTop: 2 },
  toggleRow: { flexDirection: "row", gap: 8, marginTop: 14, marginBottom: 6 },
  toggle: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
  },
  toggleOn: { backgroundColor: C.primary, borderColor: C.primary },
  toggleText: { color: C.textMuted, fontWeight: "600", fontSize: 13 },
  toggleTextOn: { color: "#FFFFFF" },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    color: C.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  codeBadge: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 10,
    minWidth: 58,
    alignItems: "center",
  },
  codeBadgeText: { fontSize: 12, fontWeight: "700", color: C.textMuted, fontFamily: MONO },
  rowName: { fontSize: 15, color: C.text, flex: 1, paddingRight: 8 },
  badge: {
    backgroundColor: "#FBEAE3",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: { fontSize: 11, color: C.coral, fontWeight: "700" },
  emptySearch: { color: C.textMuted, fontSize: 14, marginTop: 20, textAlign: "center" },
});
