import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.55.0').catch(reportFatal);

