import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.58.0').catch(reportFatal);

