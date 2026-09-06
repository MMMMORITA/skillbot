import { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { panelPlugin } from './panel';
import { sqlPlugin } from './sql';
import { galleryPlugin } from './gallery';

const plugins: JupyterFrontEndPlugin<void>[] = [panelPlugin, sqlPlugin, galleryPlugin];
export default plugins;
