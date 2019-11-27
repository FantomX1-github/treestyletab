/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2011-2019
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 wanabe <https://github.com/wanabe>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *                 Xidorn Quan <https://github.com/upsuper> (Firefox 40+ support)
 *                 lv7777 (https://github.com/lv7777)
 *
 * ***** END LICENSE BLOCK ******/
'use strict';

import {
  log as internalLogger,
  configs
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as SidebarConnection from '/common/sidebar-connection.js';

import Tab from '/common/Tab.js';

import * as TabsMove from './tabs-move.js';
import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/tabs-open', ...args);
}

const SEARCH_PREFIX_MATCHER = /^(ext\+treestyletab:search:|about:treestyletab-search\?)/;

export async function loadURI(uri, options = {}) {
  if (!options.windowId && !options.tab)
    throw new Error('missing loading target window or tab');
  try {
    let tabId;
    if (options.tab) {
      tabId = options.tab.id;
    }
    else {
      const tabs = await browser.tabs.query({
        windowId: options.windowId,
        active:   true
      }).catch(ApiTabs.createErrorHandler());
      tabId = tabs[0].id;
    }
    let searchQuery = null;
    if (SEARCH_PREFIX_MATCHER.test(uri)) {
      const query = uri.replace(SEARCH_PREFIX_MATCHER, '');
      if (browser.search &&
          typeof browser.search.search == 'function')
        searchQuery = query;
      else
        uri = configs.defaultSearchEngine.replace(/%s/gi, query);
    }
    if (searchQuery) {
      await browser.search.search({
        query: searchQuery,
        tabId
      }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
    }
    else {
      await browser.tabs.update(tabId, {
        url: uri
      }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
    }
  }
  catch(e) {
    ApiTabs.handleMissingTabError(e);
  }
}

export async function openNewTab(options = {}) {
  return openURIInTab(null, options);
}

export async function openURIInTab(uri, options = {}) {
  const tabs = await openURIsInTabs([uri], options);
  return tabs[0];
}

export async function openURIsInTabs(uris, options = {}) {
  log('openURIsInTabs: ', { uris, options });
  if (!options.windowId)
    throw new Error('missing loading target window\n' + new Error().stack);

  return Tab.doAndGetNewTabs(async () => {
    await Tab.waitUntilTrackedAll(options.windowId);
    await TabsMove.waitUntilSynchronized(options.windowId);
    const startIndex = Tab.calculateNewTabIndex(options);
    log('startIndex: ', startIndex);
    const window = TabsStore.windows.get(options.windowId);
    window.toBeOpenedTabsWithPositions += uris.length;
    if (options.isOrphan)
      window.toBeOpenedOrphanTabs += uris.length;
    return Promise.all(uris.map(async (uri, index) => {
      const params = {
        windowId: options.windowId,
        active:   index == 0 && !options.inBackground
      };
      let searchQuery = null;
      if (uri) {
        if (SEARCH_PREFIX_MATCHER.test(uri)) {
          const query = uri.replace(SEARCH_PREFIX_MATCHER, '');
          if (browser.search &&
              typeof browser.search.search == 'function')
            searchQuery = query;
          else
            params.url = configs.defaultSearchEngine.replace(/%s/gi, query);
        }
        else {
          params.url = uri;
        }
      }
      if (options.opener)
        params.openerTabId = options.opener.id;
      if (startIndex > -1)
        params.index = startIndex + index;
      if (options.cookieStoreId)
        params.cookieStoreId = options.cookieStoreId;
        // Tabs opened with different container can take time to be tracked,
        // then TabsStore.waitUntilTabsAreCreated() may be resolved before it is
        // tracked like as "the tab is already closed". So we wait until the
        // tab is correctly tracked.
      const promisedNewTabTracked = new Promise((resolve, reject) => {
        const listener = (tab) => {
          Tab.onCreating.removeListener(listener);
          browser.tabs.get(tab.id)
            .then(resolve)
            .catch(ApiTabs.createErrorSuppressor(reject));
        };
        Tab.onCreating.addListener(listener);
      });
      if (options.discarded && index > 0)
        params.discarded = true;
      const createdTab = await browser.tabs.create(params).catch(ApiTabs.createErrorHandler());
      await Promise.all([
        promisedNewTabTracked, // TabsStore.waitUntilTabsAreCreated(createdTab.id),
        searchQuery && browser.search.search({
          query: searchQuery,
          tabId: createdTab.id
        }).catch(ApiTabs.createErrorHandler())
      ]);
      const tab = Tab.get(createdTab.id);
      log('created tab: ', tab);
      if (!tab)
        throw new Error('tab is already closed');
      if (!options.opener &&
          options.parent &&
          !options.isOrphan)
        await Tree.attachTabTo(tab, options.parent, {
          insertBefore: options.insertBefore,
          insertAfter:  options.insertAfter,
          forceExpand:  params.active,
          broadcast:    true
        });
      else if (options.insertBefore)
        await TabsMove.moveTabInternallyBefore(tab, options.insertBefore, {
          broadcast: true
        });
      else if (options.insertAfter)
        await TabsMove.moveTabInternallyAfter(tab, options.insertAfter, {
          broadcast: true
        });
      log('tab is opened.');
      await tab.$TST.opened;
      return tab;
    }));
  }, options.windowId);
}


async function onMessage(message, openerTab) {
  switch (message.type) {
    case Constants.kCOMMAND_LOAD_URI:
      loadURI(message.uri, {
        tab: Tab.get(message.tabId)
      });
      break;

    case Constants.kCOMMAND_OPEN_TAB:
      if (!message.parentId && openerTab)
        message.parentId = openerTab.id;
      if (!message.windowId && openerTab)
        message.windowId = openerTab.windowId;
      await Tab.waitUntilTracked([
        message.parentId,
        message.insertBeforeId,
        message.insertAfterId
      ]);
      openURIsInTabs(message.uris || [message.uri], {
        windowId:     message.windowId,
        parent:       Tab.get(message.parentId),
        insertBefore: Tab.get(message.insertBeforeId),
        insertAfter:  Tab.get(message.insertAfterId)
      });
      break;

    case Constants.kCOMMAND_NEW_TABS:
      await Tab.waitUntilTracked([
        message.openerId,
        message.parentId,
        message.insertBeforeId,
        message.insertAfterId
      ]);
      log('new tabs requested: ', message);
      openURIsInTabs(message.uris, {
        windowId:     message.windowId,
        opener:       Tab.get(message.openerId),
        parent:       Tab.get(message.parentId),
        insertBefore: Tab.get(message.insertBeforeId),
        insertAfter:  Tab.get(message.insertAfterId)
      });
      break;
  }
}

SidebarConnection.onMessage.addListener((windowId, message) => {
  onMessage(message);
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message ||
      typeof message.type != 'string' ||
      message.type.indexOf('treestyletab:') != 0)
    return;

  onMessage(message, sender.tab);
});
