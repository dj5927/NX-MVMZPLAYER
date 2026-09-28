import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.51.0').catch(reportFatal);

