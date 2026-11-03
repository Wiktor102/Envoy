// English and Polish strings for the extension panel and its statuses.
// The Messenger page language wins when present; otherwise the browser UI
// language is used, falling back to English. Fixed backend task details
// localize through the details tables; model-written agent text and agent
// chat entries stay as sent.
import type { TaskDetailCode } from "@envoy/contracts";

export type Locale = "en" | "pl";

export function resolveLocale(tag: string | null | undefined): Locale {
	return tag?.trim().toLowerCase().startsWith("pl") ? "pl" : "en";
}

function extensionUiLanguage(): string | null {
	if (typeof chrome === "undefined") return null;
	try {
		return chrome.i18n?.getUILanguage?.() ?? null;
	} catch {
		return null;
	}
}

export function detectLocale(): Locale {
	const page = globalThis.document?.documentElement?.lang;
	if (page) return resolveLocale(page);
	return resolveLocale(extensionUiLanguage() ?? globalThis.navigator?.language ?? null);
}

// Messenger reloads on a language change, but a programmatic lang switch
// should still repaint the panel without one.
export function observeLocaleChange(onChange: (locale: Locale) => void): () => void {
	let current = detectLocale();
	const notify = () => {
		const next = detectLocale();
		if (next === current) return;
		current = next;
		onChange(next);
	};
	const observer = new MutationObserver(notify);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
	window.addEventListener("languagechange", notify);
	return () => {
		observer.disconnect();
		window.removeEventListener("languagechange", notify);
	};
}

export function format(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match));
}

export interface ExtensionStrings {
	tabsLabel: string;
	chatsTab: string;
	envoyTab: string;
	envoySettings: string;
	replySending: string;
	autoSendReplies: string;
	sendAfter: string;
	shortestDelay: string;
	longestDelay: string;
	developer: string;
	developerMode: string;
	devMode: string;
	editInstructions: string;
	goal: string;
	taskActions: string;
	pause: string;
	resume: string;
	takeOver: string;
	deleteTask: string;
	yourInstructions: string;
	goalAndLimits: string;
	goalPlaceholder: string;
	startTask: string;
	updateInstructions: string;
	conversationWithEnvoy: string;
	agentEmpty: string;
	proposedReply: string;
	editReply: string;
	saveReply: string;
	replyControls: string;
	sendNow: string;
	edit: string;
	regenerate: string;
	cancelReply: string;
	cancel: string;
	reconnect: string;
	answerEnvoy: string;
	answerPlaceholder: string;
	sendAnswer: string;
	conversationDiagnostics: string;
	messagePreview: string;
	latestFive: string;
	previewScopeHint: string;
	noMessagesLoaded: string;
	latestLoadedMessages: string;
	backendConnection: string;
	checkBackendHealth: string;
	statusThinking: string;
	statusWaiting: string;
	statusPending: string;
	statusEditing: string;
	statusSending: string;
	statusPaused: string;
	statusNeedsUser: string;
	statusCompleted: string;
	statusTakenOver: string;
	noConversation: string;
	chatLine: string;
	chatNameLine: string;
	taskIdLine: string;
	taskChatLine: string;
	openConversation: string;
	incomingLabel: string;
	you: string;
	systemName: string;
	unknownSender: string;
	unsentPlaceholder: string;
	attachmentPlaceholder: string;
	emptyPlaceholder: string;
	sendingNow: string;
	sendingIn: string;
	waitingToSend: string;
	autoSendStopped: string;
	waitingSendNow: string;
	charsUnit: string;
	tooLong: string;
	goalUpdateNote: string;
	delayManual: string;
	delayFixed: string;
	delayRandom: string;
	delayAppliesNow: string;
	saveEditNote: string;
	taskElsewhere: string;
	notConnectedNote: string;
	agentName: string;
	ownerPaused: string;
	ownerElsewhere: string;
	deleteCheck: string;
	deleteDisconnect: string;
	actionFailedFallback: string;
	checkingBackend: string;
	backendHealthy: string;
	backendUnavailable: string;
	chatChanged: string;
	unreadablePaused: string;
	confirmLatest: string;
	openAndReload: string;
	messagesUnavailable: string;
	loadingConversation: string;
	connectionInterrupted: string;
	reportFailed: string;
	backendDown: string;
	tabBusy: string;
	controlsUnavailable: string;
	actionFailed: string;
	conversationChanged: string;
	openAndWait: string;
	openTaskChat: string;
	notOwner: string;
	noTaskToDelete: string;
	extensionDown: string;
	backendRejected: string;
	details: Record<TaskDetailCode, string>;
}

const en: ExtensionStrings = {
	tabsLabel: "Chats sidebar",
	chatsTab: "Chats",
	envoyTab: "Envoy",
	envoySettings: "Envoy settings",
	replySending: "Reply sending",
	autoSendReplies: "Auto-send replies",
	sendAfter: "Send after",
	shortestDelay: "Shortest delay in seconds",
	longestDelay: "Longest delay in seconds",
	developer: "Developer",
	developerMode: "Developer mode",
	devMode: "Dev mode",
	editInstructions: "Edit instructions",
	goal: "Goal",
	taskActions: "Task actions",
	pause: "Pause",
	resume: "Resume",
	takeOver: "Take over",
	deleteTask: "Delete task",
	yourInstructions: "Your instructions",
	goalAndLimits: "Goal and limits",
	goalPlaceholder:
		"Arrange a coffee next week. I’m free Tuesday or Thursday after 3 pm. Ask me before confirming a place.",
	startTask: "Start task",
	updateInstructions: "Update instructions",
	conversationWithEnvoy: "Conversation with Envoy",
	agentEmpty: "Envoy's questions and your answers will appear here.",
	proposedReply: "Proposed reply",
	editReply: "Edit reply",
	saveReply: "Save reply",
	replyControls: "Reply controls",
	sendNow: "Send now",
	edit: "Edit",
	regenerate: "Regenerate",
	cancelReply: "Cancel reply",
	cancel: "Cancel",
	reconnect: "Reconnect",
	answerEnvoy: "Answer Envoy",
	answerPlaceholder: "Answer Envoy; instructions stay as they are.",
	sendAnswer: "Send answer",
	conversationDiagnostics: "Conversation diagnostics",
	messagePreview: "Message preview",
	latestFive: "Latest 5",
	previewScopeHint: "Only messages currently loaded in Messenger are available to Envoy.",
	noMessagesLoaded: "No messages loaded yet.",
	latestLoadedMessages: "Latest loaded messages",
	backendConnection: "Backend connection",
	checkBackendHealth: "Check backend health",
	statusThinking: "Thinking",
	statusWaiting: "Waiting for a new message",
	statusPending: "Reply ready",
	statusEditing: "Reply paused for editing",
	statusSending: "Sending reply",
	statusPaused: "Paused",
	statusNeedsUser: "Needs your input",
	statusCompleted: "Completed",
	statusTakenOver: "Taken over",
	noConversation: "No conversation selected.",
	chatLine: "Chat: {id}",
	chatNameLine: "Chat name: {name}",
	taskIdLine: "Task ID: {id}",
	taskChatLine: "Task chat: {id}",
	openConversation: "Open a conversation to read its messages.",
	incomingLabel: "Other person",
	you: "You",
	systemName: "System",
	unknownSender: "Unknown sender",
	unsentPlaceholder: "[Unsent message]",
	attachmentPlaceholder: "[Attachment]",
	emptyPlaceholder: "[Empty message]",
	sendingNow: "Sending...",
	sendingIn: "Sending in {seconds}s.",
	waitingToSend: "Waiting to send...",
	autoSendStopped: "Automatic sending is stopped.",
	waitingSendNow: "Waiting for Send now.",
	charsUnit: "characters",
	tooLong: ". Too long, shorten the text.",
	goalUpdateNote: "Changes apply after you choose Update instructions. ",
	delayManual: "Replies wait until you choose Send now.",
	delayFixed: "Replies send after a {min}-second countdown.",
	delayRandom: "Replies send after a random {min}–{max}-second countdown.",
	delayAppliesNow: " Changes apply right away.",
	saveEditNote: "Saving keeps the reply paused. Use Send now when it is ready.",
	taskElsewhere: "This task belongs to another conversation. Reopen its dedicated tab to continue.",
	notConnectedNote: " (Not connected to this tab.)",
	agentName: "Envoy",
	ownerPaused: "This task is paused. Reconnect to control it from this tab.",
	ownerElsewhere: "This task is controlled by another tab.",
	deleteCheck: "Check the conversation for any unconfirmed send before deleting this task.",
	deleteDisconnect: " The original tab must disconnect first.",
	actionFailedFallback: "Could not complete that action. Check the connection and try again.",
	checkingBackend: "Checking backend...",
	backendHealthy: "Backend healthy.",
	backendUnavailable: "Backend unavailable.",
	chatChanged: "The selected chat changed. Reload this tab to use Envoy in it.",
	unreadablePaused: "Some messages can't be read. Envoy is paused for this conversation.",
	confirmLatest: "Can't confirm the latest messages. Scroll to the bottom or reload this tab.",
	openAndReload: "Open a conversation and reload this tab to use Envoy in it.",
	messagesUnavailable: "Conversation messages are unavailable or still loading.",
	loadingConversation: "Loading the selected conversation...",
	connectionInterrupted: "Agent tab connection interrupted. Envoy is paused.",
	reportFailed: "Could not report the send result. Check Messenger before taking over.",
	backendDown: "Backend connection unavailable. Pending sends will pause.",
	tabBusy: "The tab is unavailable or another action is in progress.",
	controlsUnavailable: "The Envoy controls are unavailable.",
	actionFailed: "The action failed.",
	conversationChanged: "The conversation changed. Try again once it has loaded.",
	openAndWait: "Open a conversation and wait for it to load.",
	openTaskChat: "Open the task's conversation before reconnecting.",
	notOwner: "This tab does not control the task.",
	noTaskToDelete: "There is no task to delete.",
	extensionDown: "Extension connection unavailable. Reload Messenger.",
	backendRejected: "Backend unavailable or request rejected. Check the task and try again.",
	details: {
		previous_send_may_have_completed: "The previous send may have completed. Check the conversation before resuming.",
		reconnected_send_may_have_completed:
			"Reconnected. A send may have completed; check the conversation before resuming.",
		reconnected_resume_ready: "Reconnected. Resume when you are ready.",
		send_may_have_completed_before_editing: "The send may have completed. Check the conversation before editing.",
		countdown_stopped_while_editing: "The countdown is stopped while you edit.",
		edited_reply_saved: "Edited reply saved. Choose Send now when it is ready.",
		sending_when_tab_checks_in: "Sending when the agent tab checks in.",
		send_may_have_completed_before_resuming: "The send may have completed. Check the conversation before resuming.",
		reply_cancelled_waiting: "Reply cancelled. Waiting for a new message.",
		paused_send_may_have_completed: "Paused. The send may have completed; check the conversation before resuming.",
		paused_checking_previous_send: "Paused. Checking whether the previous send completed.",
		paused_by_you: "Paused by you.",
		taken_over_send_may_have_completed: "You are in control. A send may have completed; check the conversation.",
		taken_over_checking_previous_send: "You are in control. Checking whether the previous send completed.",
		taken_over_in_control: "You are in control of this conversation.",
		checking_previous_send_before_sending: "Checking whether the previous send completed before sending this reply.",
		checking_conversation_before_sending: "Checking the conversation before sending.",
		reply_not_sent_retry: "The reply was not sent. Choose Send now to try again, or cancel it.",
		reply_sent_waiting: "Reply sent. Waiting for a new message.",
		reply_not_sent_check_conversation: "The reply was not sent. Check the conversation before resuming.",
		send_unconfirmed_check_conversation: "The send could not be confirmed. Check the conversation before resuming.",
		auto_send_off: "Automatic sending is off. Choose Send now when it is ready.",
		previous_send_may_have_completed_before_new_task:
			"A previous send may have completed. Check the conversation before starting another task.",
		paused_previous_send_may_have_completed:
			"Paused. A previous send may have completed; check the conversation before resuming.",
		previous_send_may_have_completed_before_resuming:
			"A previous send may have completed. Check the conversation before resuming.",
		checking_previous_send: "Checking whether the previous send completed.",
		latest_unsent_check_conversation: "The latest message was unsent. Check the conversation before resuming.",
		waiting_for_incoming: "Waiting for a new incoming message.",
		latest_unknown_sender: "The latest message has an unknown sender. Check the conversation before resuming.",
		latest_unreadable: "The latest message contains content Envoy cannot interpret.",
		latest_quotes_image: "The latest message quotes an image Envoy cannot read. Take over to reply yourself.",
		latest_quotes_media: "The latest message quotes media Envoy cannot read. Take over to reply yourself.",
		considering_conversation: "Considering the conversation.",
		checking_if_task_complete: "Checking if the task is complete.",
		model_no_decision: "The model could not produce a decision. Check its configuration and resume.",
		model_key_missing: "Set MODEL_API_KEY on the backend and resume.",
		model_invalid_reply: "The model returned an invalid reply. Check the conversation.",
		review_reply_before_send: "Review the reply before it sends.",
		waiting_for_message: "Waiting for a new message.",
		tab_changed_conversations: "The agent tab changed conversations.",
		conversation_unavailable_resumable:
			"The conversation is unavailable. Envoy resumes when it can read the latest messages.",
		conversation_unavailable: "The conversation is unavailable.",
		conversation_unverifiable: "The conversation could not be verified. Reopen it and resume.",
		reply_unverifiable: "The reply could not be verified. Check the conversation before resuming.",
		tab_disconnected: "The agent tab disconnected.",
		tab_stopped_checking_in: "The agent tab stopped checking in.",
		tab_changed_conversations_send_uncertain:
			"The agent tab changed conversations. A send may have completed; check the conversation.",
		conversation_unavailable_resumable_send_uncertain:
			"The conversation is unavailable. Envoy resumes when it can read the latest messages. A send may have completed; check the conversation.",
		conversation_unavailable_send_uncertain:
			"The conversation is unavailable. A send may have completed; check the conversation.",
		conversation_unverifiable_send_uncertain:
			"The conversation could not be verified. Reopen it and resume. A send may have completed; check the conversation.",
		reply_unverifiable_send_uncertain:
			"The reply could not be verified. Check the conversation before resuming. A send may have completed; check the conversation.",
		tab_disconnected_send_uncertain: "The agent tab disconnected. A send may have completed; check the conversation.",
		tab_stopped_checking_in_send_uncertain:
			"The agent tab stopped checking in. A send may have completed; check the conversation.",
	},
};

const pl: ExtensionStrings = {
	tabsLabel: "Pasek boczny czatów",
	chatsTab: "Czaty",
	envoyTab: "Envoy",
	envoySettings: "Ustawienia Envoy",
	replySending: "Wysyłanie odpowiedzi",
	autoSendReplies: "Automatyczne wysyłanie odpowiedzi",
	sendAfter: "Wyślij po",
	shortestDelay: "Najkrótsze opóźnienie w sekundach",
	longestDelay: "Najdłuższe opóźnienie w sekundach",
	developer: "Deweloper",
	developerMode: "Tryb dewelopera",
	devMode: "Tryb dev",
	editInstructions: "Edytuj instrukcje",
	goal: "Cel",
	taskActions: "Działania zadania",
	pause: "Wstrzymaj",
	resume: "Wznów",
	takeOver: "Przejmij",
	deleteTask: "Usuń zadanie",
	yourInstructions: "Twoje instrukcje",
	goalAndLimits: "Cel i ograniczenia",
	goalPlaceholder:
		"Umów się na kawę w przyszłym tygodniu. Mogę we wtorek lub czwartek po 15:00. Zapytaj mnie przed potwierdzeniem miejsca.",
	startTask: "Rozpocznij zadanie",
	updateInstructions: "Zaktualizuj instrukcje",
	conversationWithEnvoy: "Rozmowa z Envoy",
	agentEmpty: "Pytania Envoy i Twoje odpowiedzi pojawią się tutaj.",
	proposedReply: "Proponowana odpowiedź",
	editReply: "Edytuj odpowiedź",
	saveReply: "Zapisz odpowiedź",
	replyControls: "Sterowanie odpowiedzią",
	sendNow: "Wyślij teraz",
	edit: "Edytuj",
	regenerate: "Wygeneruj ponownie",
	cancelReply: "Anuluj",
	cancel: "Anuluj",
	reconnect: "Połącz ponownie",
	answerEnvoy: "Odpowiedz Envoy",
	answerPlaceholder: "Odpowiedz Envoy; instrukcje pozostają bez zmian.",
	sendAnswer: "Wyślij odpowiedź",
	conversationDiagnostics: "Diagnostyka rozmowy",
	messagePreview: "Podgląd wiadomości",
	latestFive: "Ostatnie 5",
	previewScopeHint: "Envoy widzi tylko wiadomości aktualnie załadowane w Messengerze.",
	noMessagesLoaded: "Nie załadowano jeszcze żadnych wiadomości.",
	latestLoadedMessages: "Ostatnio załadowane wiadomości",
	backendConnection: "Połączenie z backendem",
	checkBackendHealth: "Sprawdź stan backendu",
	statusThinking: "Myślenie",
	statusWaiting: "Oczekiwanie na nową wiadomość",
	statusPending: "Odpowiedź gotowa",
	statusEditing: "Odpowiedź wstrzymana do edycji",
	statusSending: "Wysyłanie odpowiedzi",
	statusPaused: "Wstrzymane",
	statusNeedsUser: "Wymaga Twojej reakcji",
	statusCompleted: "Ukończone",
	statusTakenOver: "Przejęte",
	noConversation: "Nie wybrano rozmowy.",
	chatLine: "Czat: {id}",
	chatNameLine: "Nazwa czatu: {name}",
	taskIdLine: "ID zadania: {id}",
	taskChatLine: "Czat zadania: {id}",
	openConversation: "Otwórz rozmowę, aby odczytać jej wiadomości.",
	incomingLabel: "Inna osoba",
	you: "Ty",
	systemName: "System",
	unknownSender: "Nieznany nadawca",
	unsentPlaceholder: "[Wycofana wiadomość]",
	attachmentPlaceholder: "[Załącznik]",
	emptyPlaceholder: "[Pusta wiadomość]",
	sendingNow: "Wysyłanie...",
	sendingIn: "Wysłanie za {seconds} s.",
	waitingToSend: "Oczekiwanie na wysyłkę...",
	autoSendStopped: "Automatyczne wysyłanie jest zatrzymane.",
	waitingSendNow: "Oczekiwanie na Wyślij teraz.",
	charsUnit: "znaków",
	tooLong: ". Za długi tekst, skróć go.",
	goalUpdateNote: "Zmiany zaczną obowiązywać po wybraniu Zaktualizuj instrukcje. ",
	delayManual: "Odpowiedzi czekają, aż wybierzesz Wyślij teraz.",
	delayFixed: "Odpowiedzi wyślą się po odliczaniu {min} s.",
	delayRandom: "Odpowiedzi wyślą się po losowym odliczaniu {min}–{max} s.",
	delayAppliesNow: " Zmiany obowiązują od razu.",
	saveEditNote: "Zapisanie wstrzymuje odpowiedź. Użyj Wyślij teraz, gdy będzie gotowa.",
	taskElsewhere: "To zadanie należy do innej rozmowy. Otwórz jej dedykowaną kartę, aby kontynuować.",
	notConnectedNote: " (Niezwiązane z tą kartą.)",
	agentName: "Envoy",
	ownerPaused: "To zadanie jest wstrzymane. Połącz ponownie, aby sterować nim z tej karty.",
	ownerElsewhere: "To zadanie jest sterowane z innej karty.",
	deleteCheck: "Przed usunięciem zadania sprawdź w rozmowie, czy jakaś wysyłka nie pozostała niepotwierdzona.",
	deleteDisconnect: " Pierwotna karta musi najpierw się rozłączyć.",
	actionFailedFallback: "Nie udało się wykonać tej czynności. Sprawdź połączenie i spróbuj ponownie.",
	checkingBackend: "Sprawdzanie backendu...",
	backendHealthy: "Backend działa.",
	backendUnavailable: "Backend niedostępny.",
	chatChanged: "Wybrany czat się zmienił. Przeładuj tę kartę, aby używać w niej Envoy.",
	unreadablePaused: "Niektórych wiadomości nie można odczytać. Envoy jest wstrzymany dla tej rozmowy.",
	confirmLatest: "Nie można potwierdzić najnowszych wiadomości. Przewiń na dół lub przeładuj kartę.",
	openAndReload: "Otwórz rozmowę i przeładuj kartę, aby używać w niej Envoy.",
	messagesUnavailable: "Wiadomości rozmowy są niedostępne lub wciąż się ładują.",
	loadingConversation: "Ładowanie wybranej rozmowy...",
	connectionInterrupted: "Połączenie karty agenta przerwane. Envoy jest wstrzymany.",
	reportFailed: "Nie udało się zgłosić wyniku wysyłki. Sprawdź Messengera przed przejęciem.",
	backendDown: "Połączenie z backendem niedostępne. Oczekujące wysyłki zostaną wstrzymane.",
	tabBusy: "Karta jest niedostępna lub inna czynność jest w toku.",
	controlsUnavailable: "Sterowanie Envoy jest niedostępne.",
	actionFailed: "Czynność nie powiodła się.",
	conversationChanged: "Rozmowa się zmieniła. Spróbuj ponownie, gdy się załaduje.",
	openAndWait: "Otwórz rozmowę i poczekaj, aż się załaduje.",
	openTaskChat: "Przed ponownym połączeniem otwórz rozmowę zadania.",
	notOwner: "Ta karta nie steruje zadaniem.",
	noTaskToDelete: "Nie ma zadania do usunięcia.",
	extensionDown: "Połączenie z rozszerzeniem niedostępne. Przeładuj Messengera.",
	backendRejected: "Backend niedostępny lub żądanie odrzucone. Sprawdź zadanie i spróbuj ponownie.",
	details: {
		previous_send_may_have_completed: "Poprzednia wysyłka mogła się powieść. Sprawdź rozmowę przed wznowieniem.",
		reconnected_send_may_have_completed:
			"Połączono ponownie. Wysyłka mogła się powieść; sprawdź rozmowę przed wznowieniem.",
		reconnected_resume_ready: "Połączono ponownie. Wznów, gdy będziesz gotowy.",
		send_may_have_completed_before_editing: "Wysyłka mogła się powieść. Sprawdź rozmowę przed edycją.",
		countdown_stopped_while_editing: "Odliczanie jest wstrzymane podczas edycji.",
		edited_reply_saved: "Zapisano edytowaną odpowiedź. Wybierz Wyślij teraz, gdy będzie gotowa.",
		sending_when_tab_checks_in: "Wysłanie, gdy karta agenta się zgłosi.",
		send_may_have_completed_before_resuming: "Wysyłka mogła się powieść. Sprawdź rozmowę przed wznowieniem.",
		reply_cancelled_waiting: "Anulowano odpowiedź. Oczekiwanie na nową wiadomość.",
		paused_send_may_have_completed: "Wstrzymano. Wysyłka mogła się powieść; sprawdź rozmowę przed wznowieniem.",
		paused_checking_previous_send: "Wstrzymano. Sprawdzanie, czy poprzednia wysyłka się powiodła.",
		paused_by_you: "Wstrzymane przez Ciebie.",
		taken_over_send_may_have_completed: "Masz kontrolę. Wysyłka mogła się powieść; sprawdź rozmowę.",
		taken_over_checking_previous_send: "Masz kontrolę. Sprawdzanie, czy poprzednia wysyłka się powiodła.",
		taken_over_in_control: "Masz kontrolę nad tą rozmową.",
		checking_previous_send_before_sending:
			"Sprawdzanie, czy poprzednia wysyłka się powiodła, przed wysłaniem tej odpowiedzi.",
		checking_conversation_before_sending: "Sprawdzanie rozmowy przed wysłaniem.",
		reply_not_sent_retry: "Odpowiedź nie została wysłana. Wybierz Wyślij teraz, aby spróbować ponownie, lub ją anuluj.",
		reply_sent_waiting: "Wysłano odpowiedź. Oczekiwanie na nową wiadomość.",
		reply_not_sent_check_conversation: "Odpowiedź nie została wysłana. Sprawdź rozmowę przed wznowieniem.",
		send_unconfirmed_check_conversation: "Nie udało się potwierdzić wysyłki. Sprawdź rozmowę przed wznowieniem.",
		auto_send_off: "Automatyczne wysyłanie jest wyłączone. Wybierz Wyślij teraz, gdy odpowiedź będzie gotowa.",
		previous_send_may_have_completed_before_new_task:
			"Poprzednia wysyłka mogła się powieść. Sprawdź rozmowę przed rozpoczęciem kolejnego zadania.",
		paused_previous_send_may_have_completed:
			"Wstrzymano. Poprzednia wysyłka mogła się powieść; sprawdź rozmowę przed wznowieniem.",
		previous_send_may_have_completed_before_resuming:
			"Poprzednia wysyłka mogła się powieść. Sprawdź rozmowę przed wznowieniem.",
		checking_previous_send: "Sprawdzanie, czy poprzednia wysyłka się powiodła.",
		latest_unsent_check_conversation: "Najnowsza wiadomość została wycofana. Sprawdź rozmowę przed wznowieniem.",
		waiting_for_incoming: "Oczekiwanie na nową przychodzącą wiadomość.",
		latest_unknown_sender: "Najnowsza wiadomość ma nieznanego nadawcę. Sprawdź rozmowę przed wznowieniem.",
		latest_unreadable: "Najnowsza wiadomość zawiera treść, której Envoy nie rozumie.",
		latest_quotes_image:
			"Najnowsza wiadomość cytuje obraz, którego Envoy nie odczytuje. Przejmij, aby odpowiedzieć samodzielnie.",
		latest_quotes_media:
			"Najnowsza wiadomość cytuje multimedia, których Envoy nie odczytuje. Przejmij, aby odpowiedzieć samodzielnie.",
		considering_conversation: "Analizowanie rozmowy.",
		checking_if_task_complete: "Sprawdzanie, czy zadanie jest ukończone.",
		model_no_decision: "Model nie zwrócił decyzji. Sprawdź jego konfigurację i wznów.",
		model_key_missing: "Ustaw MODEL_API_KEY w backendzie i wznów.",
		model_invalid_reply: "Model zwrócił nieprawidłową odpowiedź. Sprawdź rozmowę.",
		review_reply_before_send: "Sprawdź odpowiedź przed wysłaniem.",
		waiting_for_message: "Oczekiwanie na nową wiadomość.",
		tab_changed_conversations: "Karta agenta zmieniła rozmowę.",
		conversation_unavailable_resumable: "Rozmowa jest niedostępna. Envoy wznowi, gdy odczyta najnowsze wiadomości.",
		conversation_unavailable: "Rozmowa jest niedostępna.",
		conversation_unverifiable: "Nie udało się zweryfikować rozmowy. Otwórz ją ponownie i wznów.",
		reply_unverifiable: "Nie udało się zweryfikować odpowiedzi. Sprawdź rozmowę przed wznowieniem.",
		tab_disconnected: "Karta agenta rozłączyła się.",
		tab_stopped_checking_in: "Karta agenta przestała się zgłaszać.",
		tab_changed_conversations_send_uncertain:
			"Karta agenta zmieniła rozmowę. Wysyłka mogła się powieść; sprawdź rozmowę.",
		conversation_unavailable_resumable_send_uncertain:
			"Rozmowa jest niedostępna. Envoy wznowi, gdy odczyta najnowsze wiadomości. Wysyłka mogła się powieść; sprawdź rozmowę.",
		conversation_unavailable_send_uncertain: "Rozmowa jest niedostępna. Wysyłka mogła się powieść; sprawdź rozmowę.",
		conversation_unverifiable_send_uncertain:
			"Nie udało się zweryfikować rozmowy. Otwórz ją ponownie i wznów. Wysyłka mogła się powieść; sprawdź rozmowę.",
		reply_unverifiable_send_uncertain:
			"Nie udało się zweryfikować odpowiedzi. Sprawdź rozmowę przed wznowieniem. Wysyłka mogła się powieść; sprawdź rozmowę.",
		tab_disconnected_send_uncertain: "Karta agenta rozłączyła się. Wysyłka mogła się powieść; sprawdź rozmowę.",
		tab_stopped_checking_in_send_uncertain:
			"Karta agenta przestała się zgłaszać. Wysyłka mogła się powieść; sprawdź rozmowę.",
	},
};

export const STRINGS: Record<Locale, ExtensionStrings> = { en, pl };

export function getStrings(locale: Locale = detectLocale()): ExtensionStrings {
	return STRINGS[locale];
}

// Only Polish needs real plural forms here; English keeps its single shape.
export function loadedMessagesText(locale: Locale, count: number): string {
	if (locale !== "pl") return `${count} loaded messages.`;
	const rule = new Intl.PluralRules("pl").select(count);
	if (rule === "one") return `${count} załadowana wiadomość.`;
	if (rule === "few") return `${count} załadowane wiadomości.`;
	return `${count} załadowanych wiadomości.`;
}
