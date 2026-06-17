export type Locale = "en" | "zh-Hant-HK" | "zh-Hans-CN";

// Map whatever the backend stores in `language` onto one of our 3 locales.
export function pickLocale(language?: string | null): Locale {
  const l = (language || "").toLowerCase();
  if (l.startsWith("zh-hant") || l === "zh-hk" || l.startsWith("zh-tw")) return "zh-Hant-HK";
  if (l.startsWith("zh-hans") || l === "zh-cn" || l === "zh") return "zh-Hans-CN";
  return "en";
}

type Dict = Record<string, string>;

// English is the source of truth.
const en: Dict = {
  brand_trust: "Private clinical conversation",
  loading: "Loading...",
  invalid_title: "Link not valid",
  invalid_body: "This invitation link is missing or not recognised.",
  unusable_title: "Link unavailable",
  unusable_expired: "This invitation has expired. Please ask for a new link.",
  unusable_status: "This invitation is no longer active. Please ask for a new link.",
  error_title: "Something went wrong",
  error_body: "Please try opening your invitation link again. If it keeps happening, ask for a new link.",
  ended_title: "Call ended",
  ended_body: "You have left the conversation. You can close this page.",
  waiting_line1: "Waiting for the session to start...",
  waiting_line2: "This page will connect you automatically when the clinician begins.",
  connected: "Connected",
  reconnecting: "Connection lost. Reconnecting...",
  mic_blocked: "Microphone blocked - you can hear others but they cannot hear you. Allow mic access and rejoin to speak.",
  mic_off_msg: "You can hear everyone, but they can't hear you yet.",
  mic_enable: "Turn on microphone",
  mic_blocked_msg: "Your microphone is blocked. Allow it for this page in your browser settings, then tap Try again.",
  mic_retry: "Try again",
  in_the_room: "In the room",
  you: "You",
  no_one_else: "No one else yet...",
  mute: "Mute",
  unmute: "Unmute",
  leave: "Leave",
  joining_as: "Joining as",
  // NOTE: the two consent_* strings are CONSENT WORDING, not just UI labels.
  // These are DRAFTS - review/finalise with your clinical + legal/DPO judgement.
  consent_recording: "I consent to this session being recorded.",
  consent_ai: "I consent to AI-generated minutes.",
  agree_join: "Agree & join",
  joining: "Joining...",
  care_conversation: "Care conversation",
};

// Traditional Chinese (Hong Kong), 書面語. DRAFT consent wording - your review required.
const zhHantHK: Dict = {
  brand_trust: "私人臨床會談",
  loading: "載入中…",
  invalid_title: "連結無效",
  invalid_body: "此邀請連結缺失或無法辨識。",
  unusable_title: "連結不可用",
  unusable_expired: "此邀請已過期，請索取新的連結。",
  unusable_status: "此邀請已失效，請索取新的連結。",
  error_title: "發生錯誤",
  error_body: "請重新開啟您的邀請連結。如問題持續，請索取新的連結。",
  ended_title: "通話已結束",
  ended_body: "您已離開對話，可關閉此頁面。",
  waiting_line1: "正在等待會議開始…",
  waiting_line2: "當醫護人員開始時，本頁將自動為您接入。",
  connected: "已連線",
  reconnecting: "連線中斷，正在重新連接…",
  mic_blocked: "麥克風已被封鎖 — 您可聽到其他人，但對方無法聽到您。請允許麥克風存取並重新加入以發言。",
  mic_off_msg: "您可聽到其他人，但對方暫時聽不到您。",
  mic_enable: "開啟麥克風",
  mic_blocked_msg: "您的麥克風已被封鎖。請在瀏覽器設定中允許本頁使用麥克風，然後按「重試」。",
  mic_retry: "重試",
  in_the_room: "與會者",
  you: "您",
  no_one_else: "暫時沒有其他人…",
  mute: "靜音",
  unmute: "取消靜音",
  leave: "離開",
  joining_as: "加入身分：",
  consent_recording: "我同意本次會議被錄製。",
  consent_ai: "我同意使用人工智能生成會議記錄。",
  agree_join: "同意並加入",
  joining: "加入中…",
  care_conversation: "照護會談",
};

// Simplified Chinese (Mainland), polite 您. DRAFT consent wording - your review required.
const zhHansCN: Dict = {
  brand_trust: "私人临床会谈",
  loading: "加载中…",
  invalid_title: "链接无效",
  invalid_body: "此邀请链接缺失或无法识别。",
  unusable_title: "链接不可用",
  unusable_expired: "此邀请已过期，请索取新的链接。",
  unusable_status: "此邀请已失效，请索取新的链接。",
  error_title: "发生错误",
  error_body: "请重新打开您的邀请链接。如问题持续，请索取新的链接。",
  ended_title: "通话已结束",
  ended_body: "您已离开对话，可关闭此页面。",
  waiting_line1: "正在等待会议开始…",
  waiting_line2: "当医护人员开始时，本页将自动为您接入。",
  connected: "已连接",
  reconnecting: "连接中断，正在重新连接…",
  mic_blocked: "麦克风已被阻止 — 您可听到其他人，但对方无法听到您。请允许麦克风访问并重新加入以发言。",
  mic_off_msg: "您可以听到其他人，但对方暂时听不到您。",
  mic_enable: "开启麦克风",
  mic_blocked_msg: "您的麦克风已被阻止。请在浏览器设置中允许本页使用麦克风，然后点按\u201c重试\u201d。",
  mic_retry: "重试",
  in_the_room: "与会者",
  you: "您",
  no_one_else: "暂时没有其他人…",
  mute: "静音",
  unmute: "取消静音",
  leave: "离开",
  joining_as: "加入身份：",
  consent_recording: "我同意本次会议被录制。",
  consent_ai: "我同意使用人工智能生成会议记录。",
  agree_join: "同意并加入",
  joining: "加入中…",
  care_conversation: "照护会谈",
};

const dicts: Record<Locale, Dict> = {
  en,
  "zh-Hant-HK": zhHantHK,
  "zh-Hans-CN": zhHansCN,
};

export function t(locale: Locale, key: string): string {
  return dicts[locale][key] ?? dicts.en[key] ?? key;
}
