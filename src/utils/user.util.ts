export function createNick(username: string, uid: string) {
  // https://github.com/ergochat/ergo/blob/6e25291c9b7450d63db59f360e1b6d90fa83e345/irc/strings.go#L19-L32
  // https://github.com/ergochat/ergo/blob/6e25291c9b7450d63db59f360e1b6d90fa83e345/irc/client_lookup_set.go#L105
  // https://github.com/ergochat/ergo/blob/6e25291c9b7450d63db59f360e1b6d90fa83e345/irc/strings.go#L93-L98
  // Also avoid ^ as that's reserved for our use
  // Our serevr is currently configured with a max nicklen of 32, so we subtract off the length of the suffix (^[uid-]xxx)
  // The fallback to "player" is in the off case all characters are special characters
  const escapedUsername =
    username
      .replace(/[ ,*?.!@:<>'";~&%+-^]/g, '')
      .replace(/^[$]/, '')
      .slice(0, -4) || 'Player';
  const connectionId = Math.floor(Math.random() * 1_000);
  if (username === escapedUsername) {
    // No escaping happened, so no need to disambiguate
    return `${username}^${connectionId}`;
  } else {
    // We include the UID to make sure we don't have collisions between usernames where we have removed disallowed
    // characters or truncated (such that whowas lookups would wind up being incorrect).
    return `${escapedUsername.slice(0, -uid.length - 1)}^${uid}-${connectionId}`;
  }
}

/**
 * Get username from nick
 */
export function parseNick(nick: string) {
  if (nick.includes('^')) {
    // Current format: 'username^connectionId'
    return nick.split('^')[0];
  } else {
    return nick;
  }
}

const UID_REGEX = /^~?(\d+)$/i;

export function parseUid(uid: string): string {
  const uidMatch = UID_REGEX.exec(uid);
  if (uidMatch) {
    return uidMatch[1];
  }

  return '0';
}

/**
 * @param mask Typically form of `username^*!*@*` (ban) or `m:username^*!*@*` (muted)
 */
export function isMaskMatch(nick: string, mask: string): boolean {
  const nickMask = mask.replace(/!.+/, '');
  // Match against ban or mute mask
  const adjustedMask = `^${nickMask.replace(/^m:/, '(m:)?').replaceAll('*', '.+').replaceAll('^', '\\^')}$`;
  const maskRegex = new RegExp(adjustedMask, 'i');
  return maskRegex.test(nick);
}
