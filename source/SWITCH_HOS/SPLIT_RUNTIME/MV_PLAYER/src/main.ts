import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.47.0').catch(reportFatal);

