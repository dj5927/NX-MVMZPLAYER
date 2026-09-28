import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.53.0').catch(reportFatal);

