import { DEFAULT_COLORS } from '#constants';
import type { User } from '#models';
import { getUserProfile } from '#services';
import { parseNick, parseUid } from '#utils';
import { useLocalStorage } from '@vueuse/core';
import log from 'loglevel';
import { defineStore } from 'pinia';
import { computed, reactive, readonly, watch } from 'vue';
import { useIrcStore } from './irc.store';

export const useUserListStore = defineStore('userList', () => {
  const irc = useIrcStore();
  /** {Username, User} */
  const knownUsers = reactive(new Map<string, User>());
  /** {Nick, Username} */
  const nickToUsername = computed(() => {
    const nickMap = new Map<string, string>();
    for (const user of knownUsers.values()) {
      for (const nick of user.nicks) {
        nickMap.set(nick.toLocaleLowerCase(), user.username);
      }
    }
    return nickMap;
  });
  const users = computed(() => Array.from(knownUsers.values()));
  const ignoredUsernames = useLocalStorage('chat_ignoredUsernames', new Set<string>());

  function addUserNick(nick: string, ident: string) {
    const displayName = parseNick(nick);
    const username = displayName.toLocaleLowerCase();
    if (knownUsers.has(username)) {
      // This user existed before and has a new nick
      const user = knownUsers.get(username)!;
      user.status = 'online';
      user.nicks.add(nick.toLocaleLowerCase());
      return;
    }

    // Create new user to track
    const uid = parseUid(ident);
    const uidAsNumber = Number.parseInt(uid, 10);
    // Assigning default username color
    const color =
      Number.isNaN(uidAsNumber) || uidAsNumber === 0
        ? '#ffffff'
        : DEFAULT_COLORS[uidAsNumber % DEFAULT_COLORS.length];
    knownUsers.set(username, {
      username,
      displayName,
      uid,
      nicks: new Set([nick.toLocaleLowerCase()]),
      status: 'online',
      awayReason: '',
      color,
      profile: null,
      isFetchingProfile: false,
    });
  }

  function getUserByNickInternal(nick: string): User | null {
    const username = nickToUsername.value.get(nick.toLocaleLowerCase());
    return username ? knownUsers.get(username)! : null;
  }

  function removeUserNick(nick: string) {
    const user = getUserByNickInternal(nick);
    if (!user) {
      log.warn(`Tried to remove user "${nick}" but they weren't in the user list.`);
      return;
    }
    user.nicks.delete(nick.toLocaleLowerCase());
    if (user.nicks.size === 0) {
      user.status = 'offline';
    }
  }

  function setUserAway(nick: string, awayReason: string) {
    const user = getUserByNickInternal(nick);
    if (!user) {
      log.warn(`Tried to mark user "${nick}" as away, but they weren't in the user list.`);
      return;
    }
    user.status = 'away';
    user.awayReason = awayReason;
  }

  function setUserBack(nick: string) {
    const user = getUserByNickInternal(nick);
    if (!user) {
      log.warn(
        `Tried to mark user "${nick}" as back (not away), but they weren't in the user list.`,
      );
      return;
    }
    user.status = 'online';
    user.awayReason = '';
  }

  async function loadProfile(username: string) {
    const user = knownUsers.get(username.toLocaleLowerCase());
    if (!user || user.isFetchingProfile || user.profile !== null) {
      return;
    }

    user.isFetchingProfile = true;
    try {
      const profile = await getUserProfile(user.uid);
      user.profile = profile;
    } catch (error) {
      log.error(error);
    } finally {
      user.isFetchingProfile = false;
    }
  }

  watch(
    () => irc.client,
    (client) => {
      if (!client) {
        return;
      }
      // Add users who JOIN a channel or are in a channel that we JOIN
      // Remove users who QUIT
      // (Not using KICK and PART since they are channel-specific)
      client
        .on('userlist', (event) => {
          for (const ircUser of event.users) {
            addUserNick(ircUser.nick, ircUser.ident);
          }
        })
        .on('join', (event) => {
          addUserNick(event.nick, event.ident);
        })
        .on('quit', (event) => {
          removeUserNick(event.nick);
        })
        .on('nick', (event) => {
          removeUserNick(event.nick);
          addUserNick(event.new_nick, event.ident);
        })
        .on('away', (event) => {
          if (event.self) {
            return;
          }
          setUserAway(event.nick, event.message);
        })
        .on('back', (event) => {
          if (event.self) {
            return;
          }
          setUserBack(event.nick);
        })
        .on('irc error', (event) => {
          if (event.error === 'no_such_nick') {
            removeUserNick(event.nick! as unknown as string);
          }
        });
    },
  );

  function ignoreUser(username: string) {
    ignoredUsernames.value.add(username.toLocaleLowerCase());
  }

  function unignoreUser(username: string) {
    ignoredUsernames.value.delete(username.toLocaleLowerCase());
  }

  function unignoreAll() {
    ignoredUsernames.value = new Set<string>();
  }

  const inFlightWhowas = reactive(new Set<string>());

  function getUserByUsername(username: string, nick?: string) {
    const user = knownUsers.get(username.toLocaleLowerCase());
    if (user) {
      return readonly(user);
    } else {
      if (nick && !inFlightWhowas.has(nick)) {
        inFlightWhowas.add(nick);
        irc.client?.whowas(nick, (event) => {
          // In case there was a race condition where it was added by join/nick "properly" after we triggered this query
          if (!getUserByNickInternal(event.nick)) {
            addUserNick(event.nick, event.ident);
            removeUserNick(event.nick);
          }
          inFlightWhowas.delete(event.nick);
        });
      }
      return null;
    }
  }

  return {
    getUserByUsername,
    getUserByNick(nick: string) {
      const user = getUserByNickInternal(nick);
      return user ? readonly(user) : null;
    },
    users,
    loadProfile,
    ignoredUsernames: readonly(ignoredUsernames),
    ignoreUser,
    unignoreUser,
    unignoreAll,
  };
});
