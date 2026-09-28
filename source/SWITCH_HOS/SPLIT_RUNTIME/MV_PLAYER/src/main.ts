import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.46.0').catch(reportFatal);

