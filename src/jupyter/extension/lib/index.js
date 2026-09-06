"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const panel_1 = require("./panel");
const sql_1 = require("./sql");
const gallery_1 = require("./gallery");
const plugins = [panel_1.panelPlugin, sql_1.sqlPlugin, gallery_1.galleryPlugin];
exports.default = plugins;
