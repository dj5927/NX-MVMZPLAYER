import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.48.0').catch(reportFatal);

