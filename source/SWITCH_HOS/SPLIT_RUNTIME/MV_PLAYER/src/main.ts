import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.63.0').catch(reportFatal);

