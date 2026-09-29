import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.72.0').catch(reportFatal);

