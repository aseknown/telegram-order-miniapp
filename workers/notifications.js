import { deliverNotifications } from '../lib/notifications.js';

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(deliverNotifications(env, 5));
  }
};
