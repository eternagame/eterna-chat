import type { ConnectionStatus, ReconnectionStatus, User } from '#models';
import { createNick } from '#utils';
import { useCountdown, useLocalStorage } from '@vueuse/core';
import { Client } from 'irc-framework';
import Connection from 'irc-framework/src/transports/websocket';
import log from 'loglevel';
import { defineStore } from 'pinia';
import { computed, markRaw, reactive, readonly, ref, shallowRef } from 'vue';

export interface InitClientConfig {
  username: string;
  uid: string;
}

export const useIrcStore = defineStore('irc', () => {
  /**
   * Tracking if the client has started the connection.
   * Keeps the chat view visible until client manually signs out.
   */
  const isInitialized = ref(false);
  /** Is a server-wide operator */
  const isOperator = ref(false);
  const client = shallowRef<Client | null>(null);
  const savedUser = useLocalStorage<Record<'username' | 'uid', string>>('chat_user', {
    username: '',
    uid: '',
  });

  const currentUser = reactive<User>({
    username: '',
    displayName: '',
    uid: '',
    status: 'online',
    awayReason: '',
    nicks: new Set<string>(),
    color: '#ffffff',
    profile: null,
    isFetchingProfile: false,
  });
  const currentNick = ref('');
  const isRegistered = ref(false);
  const connectionStatus = ref<ConnectionStatus>('disconnected');
  const reconnectionCountdown = useCountdown(0);
  const reconnectionStatus = reactive<ReconnectionStatus>({
    isReconnecting: false,
    retryCount: 0,
    retryDelay: 0,
    maxRetryCount: 0,
  });

  /**
   * Creates new IRC client with a unique nick
   */
  function initClient(username: string, uid: string) {
    if (client.value) {
      client.value.quit();
      client.value = null;
    }

    const nick = createNick(username, uid);
    currentNick.value = nick;
    currentUser.nicks.add(nick);
    currentUser.username = username.toLocaleLowerCase();
    currentUser.displayName = username;
    currentUser.uid = uid;
    isOperator.value = false;

    const ircClient = new Client({
      host: import.meta.env.VITE_APP_SERVER_URL!,
      port: import.meta.env.VITE_APP_SERVER_PORT,
      ssl: import.meta.env.VITE_APP_SSL === 'true',
      nick,
      username: uid,
      gecos: username,
      transport: Connection,
      enable_echomessage: true,
      auto_reconnect_max_retries: 10,
      auto_reconnect_max_wait: 30_000,
    })
      .on('nick in use', (event) => {
        // Remove used nick
        currentUser.nicks.delete(event.nick);
        currentNick.value = '';

        // Retry connection with new nickname
        quit();
        initClient(username, uid);
      })
      .on('connecting', () => {
        connectionStatus.value = 'connecting';
      })
      .on('registered', (event) => {
        currentNick.value = event.nick;
        currentUser.nicks.add(event.nick);
        isRegistered.value = true;
      })
      .on('connected', () => {
        isOperator.value = false;
        connectionStatus.value = 'connected';
        reconnectionStatus.isReconnecting = false;
        reconnectionCountdown.stop();
      })
      .on('reconnecting', (event) => {
        reconnectionStatus.isReconnecting = true;
        reconnectionStatus.retryCount = event.attempt;
        reconnectionStatus.retryDelay = event.wait;
        reconnectionStatus.maxRetryCount = event.max_retries;
        reconnectionCountdown.start(event.wait / 1_000);
      })
      .on('close', () => {
        isOperator.value = false;
        connectionStatus.value = 'reconnect failed';
        reconnectionStatus.isReconnecting = false;
      })
      .on('mode', (event) => {
        if (event.target !== currentNick.value) {
          return;
        }
        // Checking if user is a server operator
        for (const mode of event.modes) {
          switch (mode.mode) {
            case '+o':
              isOperator.value = true;
              return;
            case '-o':
              isOperator.value = false;
              return;
          }
        }
      })
      .on('nick', (event) => {
        if (event.nick !== currentNick.value) {
          return;
        }

        currentNick.value = event.new_nick;
        currentUser.nicks.add(event.new_nick);
        currentUser.nicks.delete(event.nick);
      });

    if (import.meta.env.DEV) {
      ircClient.on('raw', (event) => {
        if (event.from_server) {
          log.debug(
            `%c↓%c ${event.line}`,
            'color: #f00;background-color: #000',
            'color: #fff;background-color: #000',
          );
        } else {
          log.debug(
            `%c↑%c ${event.line}`,
            'color: #0f0;background-color: #000',
            'color: #fff;background-color: #000',
          );
        }
      });
    }

    ircClient.requestCap(['labeled-response', 'draft/chathistory', 'draft/event-playback']);
    ircClient.connect();
    client.value = markRaw(ircClient);
    isInitialized.value = true;

    if (import.meta.env.DEV) {
      log.debug('IRC Client:', ircClient);
    }
  }

  /** Sign in with saved login (if remembered) */
  function autoSignIn() {
    if (savedUser.value.username && savedUser.value.uid) {
      initClient(savedUser.value.username, savedUser.value.uid);
    }
  }

  function signIn(login: { username: string; uid: string; remember: boolean }) {
    if (login.remember) {
      savedUser.value = { username: login.username, uid: login.uid };
    }
    initClient(login.username, login.uid);
  }

  /**
   * Manually reconnect IRC client on unexpected disconnect.
   * Client must first be initialized by {@link autoSignIn} or {@link signIn}
   */
  function reconnect() {
    if (!isInitialized.value || !client.value || connectionStatus.value === 'connected') {
      return;
    }
    client.value.connect();
  }

  function quit() {
    isRegistered.value = false;
    connectionStatus.value = 'disconnected';
    client.value?.quit();
    client.value = null;
  }

  function signOut() {
    savedUser.value = null;
    isInitialized.value = false;
    quit();
  }

  return {
    isInitialized: readonly(isInitialized),
    client: computed(() => (isRegistered.value ? client.value : null)),
    isConnected: computed(
      () => isRegistered.value && client.value !== null && connectionStatus.value === 'connected',
    ),
    connectionStatus: readonly(connectionStatus),
    reconnectionStatus: readonly(reconnectionStatus),
    reconnectionCountdown: readonly(reconnectionCountdown.remaining),
    currentUser: readonly(currentUser),
    currentNick: readonly(currentNick),
    isOperator: readonly(isOperator),
    quit,
    signIn,
    autoSignIn,
    reconnect,
    signOut,
  };
});
