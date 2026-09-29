import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.68.0').catch(reportFatal);

