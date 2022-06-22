/* eslint no-param-reassign: 0 */
/* eslint no-multi-assign: 0 */

/*
 * Description: Make a user (spammer) dumb (mute)
 * Author: simple
 */

import {
  isModerator,
} from '../utility/_UAC';
import {
  findUser,
} from '../utility/_Channels';
import {
  Errors,
} from '../utility/_Constants';
import {
  legacyInviteReply,
  legacyWhisperReply,
} from '../utility/_LegacyFunctions';

// module support functions
/**
  * Returns the channel that should be invited to.
  * @param {any} channel
  * @return {string}
  */
export function getChannel(channel = undefined) {
  if (typeof channel === 'string') {
    return channel;
  }
  return Math.random().toString(36).substr(2, 8);
}

const parseText = (text) => {
  // verifies user input is text
  if (typeof text !== 'string') {
    return false;
  }

  let sanitizedText = text;

  // strip newlines from beginning and end
  sanitizedText = sanitizedText.replace(/^\s*\n|^\s+$|\n\s*$/g, '');
  // replace 3+ newlines with just 2 newlines
  sanitizedText = sanitizedText.replace(/\n{3,}/g, '\n\n');

  return sanitizedText;
};

// module constructor
export function init(core) {
  if (typeof core.muzzledHashes === 'undefined') {
    core.muzzledHashes = {};
  }
}

// module main
export async function run({
  core, server, socket, payload,
}) {
  // increase rate limit chance and ignore if not admin or mod
  if (!isModerator(socket.level)) {
    return server.police.frisk(socket.address, 10);
  }

  // check user input
  if (socket.hcProtocol === 1) {
    if (typeof payload.nick !== 'string') {
      return true;
    }

    payload.channel = socket.channel;
  } else if (typeof payload.userid !== 'number') {
    return true;
  }

  // find target user
  const targetUser = findUser(server, payload);
  if (!targetUser) {
    return server.reply({
      cmd: 'warn',
      text: 'Could not find user in that channel',
      id: Errors.Global.UNKNOWN_USER,
      channel: socket.channel, // @todo Multichannel
    }, socket);
  }

  // likely dont need this, muting mods and admins is fine
  if (targetUser.level >= socket.level) {
    return server.reply({
      cmd: 'warn',
      text: 'This trick wont work on users of the same level',
      id: Errors.Global.PERMISSION,
      channel: socket.channel, // @todo Multichannel
    }, socket);
  }

  // store hash in mute list
  const record = core.muzzledHashes[targetUser.hash] = {
    dumb: true,
  };

  // store allies if needed
  if (payload.allies && Array.isArray(payload.allies)) {
    record.allies = payload.allies;
  }

  // notify mods
  server.broadcast({
    cmd: 'info',
    text: `${socket.nick}#${socket.trip} muzzled ${targetUser.nick} in ${payload.channel}, userhash: ${targetUser.hash}`,
    channel: false, // @todo Multichannel, false for global
  }, { level: isModerator });

  return true;
}

// module hook functions
export function initHooks(server) {
  server.registerHook('in', 'chat', this.chatCheck.bind(this), 10);
  server.registerHook('in', 'invite', this.inviteCheck.bind(this), 10);
  server.registerHook('in', 'whisper', this.whisperCheck.bind(this), 10);
}

// hook incoming chat commands, shadow-prevent chat if they are muzzled
export function chatCheck({
  core, server, socket, payload,
}) {
  if (typeof payload.text !== 'string') {
    return false;
  }

  if (core.muzzledHashes[socket.hash]) {
    // build fake chat payload
    const outgoingPayload = {
      cmd: 'chat',
      nick: socket.nick, /* @legacy */
      uType: socket.uType, /* @legacy */
      userid: socket.userid,
      channel: socket.channel,
      text: payload.text,
      level: socket.level,
    };

    if (socket.trip) {
      outgoingPayload.trip = socket.trip;
    }

    if (socket.color) {
      outgoingPayload.color = socket.color;
    }

    // broadcast to any duplicate connections in channel
    server.broadcast(outgoingPayload, { channel: socket.channel, hash: socket.hash });

    // broadcast to allies, if any
    if (core.muzzledHashes[socket.hash].allies) {
      server.broadcast(
        outgoingPayload,
        {
          channel: socket.channel,
          nick: core.muzzledHashes[socket.hash].allies,
        },
      );
    }

    /**
      * Blanket "spam" protection.
      * May expose the ratelimiting lines from `chat` and use that
      * @todo one day #lazydev
      */
    server.police.frisk(socket.address, 9);

    return false;
  }

  return payload;
}

// shadow-prevent all invites from muzzled users
export function inviteCheck({
  core, server, socket, payload,
}) {
  if (core.muzzledHashes[socket.hash]) {
    // check for spam
    if (server.police.frisk(socket.address, 2)) {
      return server.reply({
        cmd: 'warn',
        text: 'You are sending invites too fast. Wait a moment before trying again.',
        id: Errors.Invite.RATELIMIT,
        channel: socket.channel, // @todo Multichannel
      }, socket);
    }

    // verify user input
    // if this is a legacy client add missing params to payload
    if (socket.hcProtocol === 1) {
      if (typeof socket.channel === 'undefined' || typeof payload.nick !== 'string') {
        return true;
      }

      payload.channel = socket.channel; // eslint-disable-line no-param-reassign
    } else if (typeof payload.userid !== 'number' || typeof payload.channel !== 'string') {
      return true;
    }

    // @todo Verify this socket is part of payload.channel - multichannel patch
    // find target user
    const targetUser = findUser(server, payload);
    if (!targetUser) {
      return server.reply({
        cmd: 'warn',
        text: 'Could not find user in that channel',
        id: Errors.Global.UNKNOWN_USER,
        channel: socket.channel, // @todo Multichannel
      }, socket);
    }

    // generate common channel
    const channel = getChannel(payload.to);

    // build invite
    const outgoingPayload = {
      cmd: 'invite',
      channel: socket.channel, // @todo Multichannel
      from: socket.userid,
      to: targetUser.userid,
      inviteChannel: channel,
    };

    // send invite notice to this client
    if (socket.hcProtocol === 1) {
      server.reply(legacyInviteReply(outgoingPayload, targetUser.nick), socket);
    } else {
      server.reply(outgoingPayload, socket);
    }

    return false;
  }

  return payload;
}

// shadow-prevent all whispers from muzzled users
export function whisperCheck({
  core, server, socket, payload,
}) {
  if (core.muzzledHashes[socket.hash]) {
    // if this is a legacy client add missing params to payload
    if (socket.hcProtocol === 1) {
      payload.channel = socket.channel; // eslint-disable-line no-param-reassign
    }

    // verify user input
    const text = parseText(payload.text);

    if (!text) {
      // lets not send objects or empty text, yea?
      return server.police.frisk(socket.address, 13);
    }

    // check for spam
    const score = text.length / 83 / 4;
    if (server.police.frisk(socket.address, score)) {
      return server.reply({
        cmd: 'warn', // @todo Add numeric error code as `id`
        text: 'You are sending too much text. Wait a moment and try again.\nPress the up arrow key to restore your last message.',
        channel: socket.channel, // @todo Multichannel
      }, socket);
    }

    const targetUser = findUser(server, payload);
    if (!targetUser) {
      return server.reply({
        cmd: 'warn',
        text: 'Could not find user in that channel',
        id: Errors.Global.UNKNOWN_USER,
        channel: socket.channel, // @todo Multichannel
      }, socket);
    }

    const outgoingPayload = {
      cmd: 'whisper',
      channel: socket.channel, // @todo Multichannel
      from: socket.userid,
      to: targetUser.userid,
      text,
    };

    // send invite notice to this client
    if (socket.hcProtocol === 1) {
      server.reply(legacyWhisperReply(outgoingPayload, targetUser.nick), socket);
    } else {
      server.reply(outgoingPayload, socket);
    }

    targetUser.whisperReply = socket.nick;

    return false;
  }

  return payload;
}

// export const requiredData = ['nick'];
export const info = {
  name: 'dumb',
  description: 'Globally shadow mute a connection. Optional allies array will see muted messages.',
  usage: `
    API: { cmd: 'dumb', nick: '<target nick>', allies: ['<optional nick array>', ...] }`,
};
info.aliases = ['muzzle', 'mute'];